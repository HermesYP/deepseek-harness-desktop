#!/usr/bin/env node
/**
 * fixture-provider.test.mjs — in-process tests for the local acceptance
 * fixture provider.
 *
 * The server binds an EPHEMERAL loopback port (port 0) and is driven with the
 * Node built-in fetch: these are REAL HTTP interactions against the REAL
 * fixture server, still with no application, no keyring and no external
 * network. Covered: the credential gate (fixed key accepted, anything else
 * 401), the openai-completions SSE shape (role chunk, split tool-call
 * argument deltas that reassemble to valid JSON, finish reasons, [DONE]),
 * the tool-result branch streaming the fixed reply, the cancel-marker branch
 * observing a client abort, content-free fact recording, and bounded close.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FIXTURE_API_KEY,
  FIXTURE_CANCEL_MARKER,
  FIXTURE_MODEL_ID,
  FIXTURE_REPLY_TEXT,
  FIXTURE_TOOL_NAME,
  createFixtureProvider,
  parseFixturePort,
  summariseRequestBody,
} from './fixture-provider.mjs'

/** One accepted chat-completions call; returns the raw text stream. */
async function chat(provider, body, { auth = FIXTURE_API_KEY, signal } = {}) {
  const response = await fetch(`${provider.origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  return response
}

async function readAll(response) {
  return response.text()
}

test('P1: the port guard allows 0 (ephemeral) and the server reports its bound port', async () => {
  assert.equal(parseFixturePort(0), 0)
  const provider = await createFixtureProvider({ port: 0 })
  try {
    assert.notEqual(provider.port, 0)
    assert.ok(provider.origin.startsWith('http://127.0.0.1:'))
  } finally {
    await provider.close()
  }
})

test('P2: the credential gate accepts only the fixed fixture key', async () => {
  const provider = await createFixtureProvider({ port: 0 })
  try {
    const refused = await chat(provider, { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }, { auth: 'wrong-key' })
    assert.equal(refused.status, 401)
    const accepted = await chat(provider, { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(accepted.status, 200)
    const facts = provider.facts()
    assert.equal(facts.badAuthCount, 1)
    assert.equal(facts.authAcceptedCount, 1)
  } finally {
    await provider.close()
  }
})

const TOOLS_BODY = {
  model: FIXTURE_MODEL_ID,
  stream: true,
  tools: [{ type: 'function', function: { name: FIXTURE_TOOL_NAME, parameters: { type: 'object' } } }],
  messages: [{ role: 'user', content: 'run the fixture todo' }],
}

test('P3: a tools request is answered with a streamed tool_call whose split deltas reassemble', async () => {
  const provider = await createFixtureProvider({ port: 0 })
  try {
    const response = await chat(provider, TOOLS_BODY)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u)
    const text = await readAll(response)
    const events = text.split('\n\n').filter(chunk => chunk.startsWith('data: ') && chunk !== 'data: [DONE]')
    const payloads = events.map(chunk => JSON.parse(chunk.slice('data: '.length)))
    const toolDeltas = payloads.flatMap(payload => payload.choices?.[0]?.delta?.tool_calls ?? [])
    assert.equal(toolDeltas.length, 3, 'name delta + two argument deltas')
    assert.equal(toolDeltas[0].function.name, FIXTURE_TOOL_NAME)
    const argumentsText = toolDeltas.slice(1).map(delta => delta.function.arguments).join('')
    const parsed = JSON.parse(argumentsText)
    assert.ok(Array.isArray(parsed.todos) && parsed.todos.length === 1)
    const finish = payloads.find(payload => payload.choices?.[0]?.finish_reason !== null)
    assert.equal(finish.choices[0].finish_reason, 'tool_calls')
    assert.ok(text.trimEnd().endsWith('data: [DONE]'))
    assert.equal(provider.facts().toolRoundAnswers, 1)
  } finally {
    await provider.close()
  }
})

test('P4: a tool-result request streams the fixed reply and a stop finish', async () => {
  const provider = await createFixtureProvider({ port: 0 })
  try {
    const body = {
      model: FIXTURE_MODEL_ID,
      stream: true,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', tool_calls: [{ id: 'fixture-tool-call', type: 'function', function: { name: FIXTURE_TOOL_NAME, arguments: '{}' } }] },
        { role: 'tool', content: 'ok' },
      ],
    }
    const response = await chat(provider, body)
    const text = await readAll(response)
    const payloads = text.split('\n\n').filter(chunk => chunk.startsWith('data: ') && chunk !== 'data: [DONE]').map(chunk => JSON.parse(chunk.slice(6)))
    const reply = payloads.map(payload => payload.choices?.[0]?.delta?.content ?? '').join('')
    assert.equal(reply, FIXTURE_REPLY_TEXT, 'the reply text must be streamed as delta contents')
    const finish = payloads.find(payload => payload.choices?.[0]?.finish_reason !== null)
    assert.equal(finish.choices[0].finish_reason, 'stop')
    assert.ok(text.trimEnd().endsWith('data: [DONE]'))
    assert.equal(provider.facts().finalReplies, 1)
  } finally {
    await provider.close()
  }
})

test('P5: the cancel-marker message streams slowly and records the client abort', async () => {
  const provider = await createFixtureProvider({ port: 0, chunkDelayMs: 150 })
  try {
    const controller = new AbortController()
    const response = await chat(provider, {
      model: FIXTURE_MODEL_ID,
      stream: true,
      messages: [{ role: 'user', content: `${FIXTURE_CANCEL_MARKER}: stop me` }],
    }, { signal: controller.signal })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    await reader.read() // first chunk delivered
    controller.abort()
    await assert.rejects(() => reader.read())
    await new Promise(resolve => setTimeout(resolve, 250))
    const facts = provider.facts()
    assert.equal(facts.cancelMarkerRequests, 1)
    assert.equal(facts.cancelledCount, 1, 'the abort must be observed by the fixture')
    assert.equal(facts.completedSlowStreamCount, 0)
  } finally {
    await provider.close()
  }
})

test('P6: recorded facts never carry request bodies or message content', async () => {
  const provider = await createFixtureProvider({ port: 0 })
  try {
    const secretish = 'user-message-that-must-not-be-recorded-9281'
    await chat(provider, TOOLS_BODY)
    await chat(provider, { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: secretish }] })
    const factsJson = JSON.stringify(provider.facts())
    assert.ok(!factsJson.includes(secretish), 'no message content may be recorded')
    assert.ok(!factsJson.includes(FIXTURE_API_KEY), 'the key value must never be recorded')
    assert.ok(!/token=|Bearer /u.test(factsJson), 'no credential-shaped material may be recorded')
  } finally {
    await provider.close()
  }
})

test('P7: summariseRequestBody is content-free and shape-only', () => {
  const summary = summariseRequestBody({
    model: FIXTURE_MODEL_ID,
    stream: true,
    tools: [{ type: 'function', function: { name: FIXTURE_TOOL_NAME } }],
    messages: [{ role: 'user', content: 'arbitrary user text' }, { role: 'tool', content: 'result' }],
  })
  assert.deepEqual(Object.keys(summary).sort(), [
    'hasToolResult', 'hasTools', 'lastUserMentionsCancel', 'modelIsFixture', 'namesFixtureTool', 'stream',
  ])
  assert.equal(summary.hasToolResult, true)
  assert.equal(summary.namesFixtureTool, true)
  assert.equal(JSON.stringify(summary).includes('arbitrary user text'), false)
})

test('P8: close is bounded, idempotent, and stops serving', async () => {
  const provider = await createFixtureProvider({ port: 0 })
  const origin = provider.origin
  await provider.close()
  const startedAt = Date.now()
  await provider.close()
  assert.ok(Date.now() - startedAt < 2000, 'a repeated close must return immediately')
  await assert.rejects(() => fetch(`${origin}/v1/chat/completions`, { method: 'POST', body: '{}' }))
})
