import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute the shipped script with a minimal DOM/IPC stand-in. These are NOT
// WebView2, native capability, policy-owner admission, or lifecycle tests.
const html = readFileSync(new URL('../ui/shell/public/mandatory-policy.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function surface({ invoke = async () => undefined, native = true } = {}) {
  const nodes = new Map();
  const calls = [];
  const document = {
    documentElement: {},
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {
        textContent: '', listeners: {},
        set innerHTML(_) { throw new Error('policy content must never become HTML'); },
        addEventListener(event, listener) { this.listeners[event] = listener; },
      });
      return nodes.get(id);
    },
  };
  const window = native ? { __TAURI_INTERNALS__: {
    invoke(command, args) { calls.push([command, args]); return invoke(command, args); },
  } } : {};
  vm.runInNewContext(script, { window, document });
  return { window, document, nodes, calls, render: window.__DSH_POLICY_RENDER };
}

test('surface sends no acknowledgment until native data is rendered', async () => {
  const s = surface();
  assert.equal(s.calls.length, 0);
  await s.render({ sequence: 23, clientVersion: '0.1.7-rc.2' });
  assert.deepEqual(s.calls.map(([command, args]) => [command, args.sequence]), [['policy_presented', 23]]);
  assert.equal(s.nodes.get('version').textContent, '0.1.7-rc.2');
  assert.equal(s.nodes.get('version-label').textContent, 'Client version');
});

test('policy-controlled text is inserted literally, not interpreted as HTML', async () => {
  const s = surface();
  const payload = '<img src=x onerror=alert(1)>';
  await s.render({ sequence: 24, title: payload, detail: payload, error: payload });
  for (const id of ['title', 'detail', 'error']) assert.equal(s.nodes.get(id).textContent, payload);
});

test('Chinese copy identifies the UI client version without claiming runtime identity', async () => {
  const s = surface();
  await s.render({ sequence: 25, locale: 'zh', blocking: true, title: ' ', detail: '', clientVersion: '0.2.0' });
  assert.equal(s.document.documentElement.lang, 'zh');
  assert.equal(s.nodes.get('version-label').textContent, '客户端版本');
  assert.equal(s.nodes.get('quit').textContent, '退出');
  assert.equal(s.nodes.get('title').textContent, '需要更新');
});

test('an unblocked snapshot displays pending policy copy instead of a false mandatory verdict', async () => {
  const s = surface();
  await s.render({ sequence: 29, blocking: false });
  assert.equal(s.nodes.get('title').textContent, 'Update policy');
  assert.equal(s.nodes.get('update').disabled, true);
  assert.equal(s.nodes.get('quit').textContent, 'Quit');
});

test('missing native IPC rejects presentation instead of pretending acknowledgment', async () => {
  const s = surface({ native: false });
  await assert.rejects(s.render({ sequence: 26 }), /acknowledgment unavailable/);
  assert.equal(s.calls.length, 0);
});

test('native ACK refusal propagates from the renderer presentation promise', async () => {
  const s = surface({ invoke: async () => { throw new Error('stale sequence'); } });
  await assert.rejects(s.render({ sequence: 27 }), /stale sequence/);
  assert.equal(s.calls.length, 1);
});

test('surface actions invoke only the three declared owned native actions', async () => {
  const s = surface();
  for (const id of ['retry', 'update', 'quit']) await s.nodes.get(id).listeners.click();
  assert.deepEqual(s.calls.map(([command]) => command), ['policy_retry', 'policy_update', 'policy_quit']);
});

test('action refusal displays localized generic error, not native diagnostics or secrets', async () => {
  const s = surface({ invoke: async (command) => {
    if (command !== 'policy_presented') throw new Error('private_token_do_not_display');
  } });
  await s.render({ sequence: 28, locale: 'zh' });
  await s.nodes.get('update').listeners.click();
  assert.equal(s.nodes.get('error').textContent, '操作未能完成，请重试。');
  assert.doesNotMatch(s.nodes.get('error').textContent, /private_token/);
});
