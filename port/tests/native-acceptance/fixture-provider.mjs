#!/usr/bin/env node
/**
 * fixture-provider.mjs — the clearly-labelled LOCAL fixture model provider used
 * by the native acceptance runner.
 *
 * WHAT THIS IS
 *   A bounded, single-purpose HTTP server implementing the `openai-completions`
 *   wire protocol (POST {baseURL}/chat/completions, SSE streaming) that the
 *   desktop host's `llm-pi-ai` adapter can point a provider route at. It lets
 *   the native acceptance runner exercise REAL chat streaming, ONE real tool
 *   round, and REAL cancellation inside the actual Tauri WebView2 against a
 *   provider that is unmistakably a fixture.
 *
 * WHAT THIS IS NOT
 *   * NOT a stand-in for the DeepSeek backend or for any real account: the
 *     route is named `fixture-acceptance`, the model `fixture-model`, the
 *     displayName carries "(acceptance)", and the staged config is written
 *     ONLY into the run's isolated DSH_HOME.
 *   * NOT a credential store: the only key it accepts is the fixed, non-secret
 *     acceptance string exported as an environment variable for the run. It
 *     never records request bodies, message content, or header values — only
 *     bounded booleans and counts.
 *
 * PROTOCOL SCRIPT (deterministic, for the runner's checks)
 *   1. A request carrying `tools` and NO prior tool result answers with a
 *      streamed `tool_calls` finish asking for the harmless built-in
 *      `todo_write` tool. This is the "basic tool work" round: the agent loop
 *      executes the tool client-side and issues a second provider request.
 *   2. A request whose messages include a tool result (role "tool") streams a
 *      short fixed reply ("Fixture acceptance reply.") and finishes with
 *      reason "stop".
 *   3. A request whose last user message contains the runner's cancel marker
 *      streams MANY slow chunks; when the client aborts the connection the
 *      server records `cancelled: true`. Reaching the end without an abort
 *      records `completedSlowStream: true` instead.
 *
 * BOUNDS
 *   * Listens on an explicit loopback port only (refused when it is the live
 *     GUI port 3080).
 *   * 1 MiB request-body cap; per-socket inactivity timeout; `close()` is
 *     idempotent and bounded.
 *   * Every recorded fact is a boolean, a count, or a short non-content string
 *     (model id, finish reason). Nothing secret-shaped is ever stored.
 */

import { createServer } from 'node:http'

/** The live Harness GUI port; never bound, never targeted. */
export const LIVE_GUI_PORT = 3080

/** The fixed, clearly-labelled, non-secret fixture credential. */
export const FIXTURE_API_KEY = 'dsh-acceptance-fixture-key'

/** The env var name the staged provider profile references via apiKeyEnv. */
export const FIXTURE_KEY_ENV = 'DSH_ACCEPTANCE_FIXTURE_KEY'

/** The provider route / model ids the staged config uses. */
export const FIXTURE_ROUTE = 'fixture-acceptance'
export const FIXTURE_MODEL_ID = 'fixture-model'

/** The harmless tool the fixture asks the agent to run (client-side, no fs). */
export const FIXTURE_TOOL_NAME = 'todo_write'

/** The streamed reply the success check looks for. */
export const FIXTURE_REPLY_TEXT = 'Fixture acceptance reply.'

/** The marker the runner places in the message used for the cancel test. */
export const FIXTURE_CANCEL_MARKER = 'fixture-cancel-test'

const MAX_BODY_BYTES = 1024 * 1024
const SOCKET_IDLE_MS = 15000

/**
 * Validate a fixture port. `0` selects an ephemeral loopback port (used by the
 * fixture's own tests); any explicit port must be in [1024, 65535] and never
 * the live GUI port.
 * @param {number|string} raw
 * @returns {number}
 */
export function parseFixturePort(raw) {
  const port = Number(raw)
  if (port === 0) return 0
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`fixture port must be an integer within [1024, 65535], got ${String(raw)}`)
  }
  if (port === LIVE_GUI_PORT) {
    throw new Error(`fixture port must not be ${LIVE_GUI_PORT}: that is the live Harness GUI`)
  }
  return port
}

/**
 * Extract bounded, content-free facts from one request body. Message text is
 * NEVER copied out; only shapes and the two markers the runner needs.
 */
export function summariseRequestBody(body) {
  const summary = {
    stream: body?.stream === true,
    modelIsFixture: body?.model === FIXTURE_MODEL_ID,
    hasTools: Array.isArray(body?.tools) && body.tools.length > 0,
    namesFixtureTool: Array.isArray(body?.tools)
      && body.tools.some(tool => JSON.stringify(tool?.function?.name ?? '') === JSON.stringify(FIXTURE_TOOL_NAME)),
    hasToolResult: Array.isArray(body?.messages)
      && body.messages.some(message => message?.role === 'tool'),
    lastUserMentionsCancel: Array.isArray(body?.messages)
      && (() => {
        for (let i = body.messages.length - 1; i >= 0; i -= 1) {
          const message = body.messages[i]
          if (message?.role !== 'user') continue
          const content = typeof message.content === 'string' ? message.content : ''
          return content.includes(FIXTURE_CANCEL_MARKER)
        }
        return false
      })(),
  }
  return summary
}

/** One SSE chunk in the openai-completions streaming shape. */
function sseChunk({ id, model, delta, finishReason }) {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * Create the fixture provider server. Resolves once it is LISTENING; the
 * caller owns `close()`.
 *
 * @param {{port: number, apiKey?: string, chunkDelayMs?: number}} options
 * @returns {Promise<{origin: string, port: number, facts: () => object, close: () => Promise<void>}>}
 */
export async function createFixtureProvider(options) {
  const port = parseFixturePort(options.port)
  const apiKey = options.apiKey ?? FIXTURE_API_KEY
  const chunkDelayMs = options.chunkDelayMs ?? 200

  /** All recorded facts are booleans/counts/short non-content strings. */
  const state = {
    providerLabel: 'fixture-acceptance (LOCAL TEST FIXTURE — not a real provider)',
    protocol: 'openai-completions',
    requestCount: 0,
    authAcceptedCount: 0,
    badAuthCount: 0,
    toolRoundAnswers: 0,
    finalReplies: 0,
    cancelMarkerRequests: 0,
    cancelledCount: 0,
    completedSlowStreamCount: 0,
    lastFinishReason: null,
    lastModelWasFixture: null,
    errorCount: 0,
    closed: false,
  }

  let sockets = new Set()
  let server = null

  const writeSseHead = res => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  /**
   * Client-gone predicate. `res.destroyed` alone does not track a fetch abort
   * reliably: the close event on the response is the dependable signal that
   * the client went away before the stream ended.
   */
  const makeClientGone = (req, res) => {
    let clientGone = false
    res.on('close', () => { clientGone = true })
    res.on('error', () => { clientGone = true })
    req.on('aborted', () => { clientGone = true })
    req.on('error', () => { clientGone = true })
    // NOTE: `req.destroyed` is deliberately NOT consulted: Node marks the
    // IncomingMessage destroyed once its body is fully consumed, which is the
    // normal case for a streamed response and not a client abort. The
    // response's own close/error events are the reliable abort signal.
    return () => {
      const gone = clientGone || res.writableEnded || res.destroyed
      if (gone && process.env.DSH_FIXTURE_DEBUG === '1') {
        console.error(`[fixture] client gone: close=${clientGone} writableEnded=${res.writableEnded} res.destroyed=${res.destroyed}`)
      }
      return gone
    }
  }

  /** Stream a fixed reply in small chunks; resolves when finished or aborted. */
  const streamText = async (req, res, text, { chunkSize = 8, delayMs = 40 } = {}) => {
    const clientGone = makeClientGone(req, res)
    writeSseHead(res)
    const id = 'fixture-acceptance-id'
    res.write(sseChunk({ id, model: FIXTURE_MODEL_ID, delta: { role: 'assistant', content: '' } }))
    for (let i = 0; i < text.length; i += chunkSize) {
      if (clientGone()) return 'aborted'
      res.write(sseChunk({ id, model: FIXTURE_MODEL_ID, delta: { content: text.slice(i, i + chunkSize) } }))
      if (i + chunkSize < text.length) await sleep(delayMs)
    }
    if (clientGone()) return 'aborted'
    res.write(sseChunk({ id, model: FIXTURE_MODEL_ID, delta: {}, finishReason: 'stop' }))
    res.write('data: [DONE]\n\n')
    res.end()
    return 'completed'
  }

  /** One slow tool-call round: todo_write, then wait for the client to finish. */
  const streamToolCall = (req, res) => {
    writeSseHead(res)
    const id = 'fixture-acceptance-tool-id'
    res.write(sseChunk({ id, model: FIXTURE_MODEL_ID, delta: { role: 'assistant', content: '' } }))
    const args = JSON.stringify({ todos: [{ content: 'Fixture acceptance todo', status: 'completed' }] })
    res.write(sseChunk({
      id,
      model: FIXTURE_MODEL_ID,
      delta: { tool_calls: [{ index: 0, id: 'fixture-tool-call', type: 'function', function: { name: FIXTURE_TOOL_NAME, arguments: '' } }] },
    }))
    // Arguments arrive in two deltas: exercises the adapter's accumulation.
    res.write(sseChunk({
      id,
      model: FIXTURE_MODEL_ID,
      delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, Math.ceil(args.length / 2)) } }] },
    }))
    res.write(sseChunk({
      id,
      model: FIXTURE_MODEL_ID,
      delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(Math.ceil(args.length / 2)) } }] },
    }))
    res.write(sseChunk({ id, model: FIXTURE_MODEL_ID, delta: {}, finishReason: 'tool_calls' }))
    res.write('data: [DONE]\n\n')
    res.end()
  }

  /** A deliberately slow stream that only ends when the client aborts it. */
  const streamSlowForever = async (req, res) => {
    const clientGone = makeClientGone(req, res)
    writeSseHead(res)
    const id = 'fixture-acceptance-slow-id'
    res.write(sseChunk({ id, model: FIXTURE_MODEL_ID, delta: { role: 'assistant', content: '' } }))
    for (let i = 0; ; i += 1) {
      if (clientGone()) {
        state.cancelledCount += 1
        return 'aborted'
      }
      res.write(sseChunk({ id, model: FIXTURE_MODEL_ID, delta: { content: 'fixture ' } }))
      await sleep(chunkDelayMs)
    }
  }

  const handleChatCompletions = async (req, res, body) => {
    state.requestCount += 1
    const summary = summariseRequestBody(body)
    state.lastModelWasFixture = summary.modelIsFixture
    if (summary.lastUserMentionsCancel) {
      // The runner's cancel test: stream slowly and record the client abort.
      state.cancelMarkerRequests += 1
      await streamSlowForever(req, res)
      return
    }
    if (summary.hasToolResult) {
      state.finalReplies += 1
      await streamText(req, res, FIXTURE_REPLY_TEXT)
      state.lastFinishReason = 'stop'
      return
    }
    if (summary.namesFixtureTool || (summary.hasTools && summary.hasToolResult === false)) {
      state.toolRoundAnswers += 1
      streamToolCall(req, res)
      state.lastFinishReason = 'tool_calls'
      return
    }
    // No tools declared: plain text reply.
    state.finalReplies += 1
    await streamText(req, res, FIXTURE_REPLY_TEXT)
    state.lastFinishReason = 'stop'
  }

  server = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '')
    const authMatched = auth === `Bearer ${apiKey}`
    if (!authMatched) {
      state.badAuthCount += 1
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fixture: credential mismatch', type: 'invalid_request_error' } }))
      return
    }
    if (req.method !== 'POST' || !String(req.url ?? '').endsWith('/chat/completions')) {
      state.errorCount += 1
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fixture: only POST /chat/completions exists', type: 'invalid_request_error' } }))
      return
    }
    state.authAcceptedCount += 1
    const chunks = []
    let size = 0
    let aborted = false
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'fixture: body too large', type: 'invalid_request_error' } }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => { aborted = true })
    req.on('end', () => {
      if (aborted) return
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
        state.errorCount += 1
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'fixture: body is not JSON', type: 'invalid_request_error' } }))
        return
      }
      const summary = summariseRequestBody(body)
      handleChatCompletions(req, res, body).catch(() => { state.errorCount += 1 })
    })
  })

  server.on('connection', socket => {
    sockets.add(socket)
    socket.setTimeout(SOCKET_IDLE_MS, () => socket.destroy())
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolveListen, rejectListen) => {
    const onError = error => { server = null; rejectListen(error) }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolveListen()
    })
  })

  const boundPort = server.address()?.port ?? port

  return {
    origin: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    /** Bounded fact snapshot; consumed by the runner's record (never content). */
    facts: () => ({ ...state }),
    /** Whether the cancel test's client abort was observed. */
    close: () => new Promise(resolveClose => {
      if (state.closed || server === null) { resolveClose(); return }
      state.closed = true
      for (const socket of sockets) { try { socket.destroy() } catch { /* bounded */ } }
      sockets = new Set()
      server.close(() => resolveClose())
      // Bounded hard stop: listening socket released even with keep-alives.
      setTimeout(() => { try { server.closeAllConnections?.() } catch { /* bounded */ } resolveClose() }, 1000).unref()
    }),
  }
}
