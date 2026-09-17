import { it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { callerKeyFromRequest } from '../src/caller-key.js';
import { messagesIdentity, MessagesIdentityAliases, identityDiagnostic } from '../src/messages-identity.js';
import { prepareNativeThinking, nativeThinkingEvents, resolveMessagesNativeScope, __thinkingTesting } from '../src/devin-thinking.js';
import { resolveSessionId, commitAfterResponse, getSessionEnvForModel, getSessionModelConfig, _resetForTests } from '../src/session-continuity.js';
import { handleMessages } from '../src/handlers/messages.js';
import { __setStreamChatForTest } from '../src/devin-connect-openai.js';
import { config } from '../src/config.js';
import { NATIVE_RETENTION_MS } from '../src/native-thinking-storage.js';

const FLAGS = { DEVIN_CONNECT: '1', DEVIN_CONNECT_NATIVE_THINKING: '1', DEVIN_CONNECT_NATIVE_THINKING_SIGNED_MODELS: 'swe-2-high',
  DEVIN_CONNECT_SESSION_REUSE: '1', DEVIN_CONNECT_MODEL_CONFIG_STABLE: '1', DEVIN_CONNECT_MESSAGES_IDENTITY_V2: '1', DEVIN_CONNECT_TOKEN: 'fixture-offline-identity-account' };
const TOKEN = 'fixture-offline-identity-account';
const request = (ua = 'ZCode provider-utils', ip = '127.0.0.1') => ({ headers: { 'user-agent': ua }, socket: { remoteAddress: ip } });
const body = (id, session = 'dialog-a') => ({ metadata: { user_id: JSON.stringify({ account_uuid: id, device_id: 'device-fixture', session_id: session }) } });
const identity = (b, ua, key = 'offline-gateway-key') => messagesIdentity(b, callerKeyFromRequest(request(ua), key, b));
const opener = () => [{ role: 'user', content: 'offline question' }];
const signed = (sig = 'offline-signature', summary = 'offline summary') => ({ role: 'assistant', content: 'offline answer', nativeThinkingBlocks: [{ type: 'thinking', thinking: summary, signature: sig }] });
const history = () => [...opener(), signed(), { role: 'user', content: 'continue' }];
const params = (scope, session, messages = history(), extra = {}) => ({ token: TOKEN, model: 'swe-2-high', nativeThinkingScope: scope, sessionId: session, messages, env: process.env, ...extra });
async function issue(scope, session, signature = 'offline-signature') {
  async function* frames() { yield { type: 'reasoning', text: 'offline summary' }; yield { type: 'signature', reasoning_signature: signature, signatureType: 'sealed' }; yield { type: 'finish' }; }
  for await (const _ of nativeThinkingEvents(frames(), params(scope, session, []))) {}
}
let saved;
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(FLAGS).map(k => [k, process.env[k]])); Object.assign(process.env, FLAGS);
  __thinkingTesting.clear(); _resetForTests();
});
afterEach(() => {
  __setStreamChatForTest(null); __thinkingTesting.clear(); _resetForTests();
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v;
});

it('keeps the authenticated metadata scope stable across UA/IP but separates principals and explicit sessions', () => {
  const b = body('user-a');
  const a = identity(b, 'stream');
  const changed = messagesIdentity(b, callerKeyFromRequest(request('generate', '10.0.0.9'), 'offline-gateway-key', b));
  assert.equal(a.stableScope, changed.stableScope); assert.notEqual(a.legacyScope, changed.legacyScope);
  assert.notEqual(a.stableScope, identity(body('user-b'), 'stream').stableScope);
  assert.notEqual(a.stableScope, identity(body('user-a', 'dialog-b'), 'stream').stableScope);
  assert.notEqual(a.stableScope, identity(b, 'stream', 'another-gateway').stableScope);
  assert.notEqual(resolveSessionId(a.stableScope, opener(), getSessionEnvForModel('swe-2-high')),
    resolveSessionId(identity(body('user-a', 'dialog-b'), 'stream').stableScope, opener(), getSessionEnvForModel('swe-2-high')));
});

it('normalizes structured aliases and opaque metadata without trusting malformed or anonymous identities', () => {
  const a = identity(body('user-a'), 'stream');
  const alias = { metadata: { user_id: JSON.stringify({ sessionId: ' dialog-a ', deviceId: 'device-fixture', accountUuid: 'user-a' }) } };
  assert.equal(a.stableScope, identity(alias, 'generate').stableScope);
  assert.equal(identity({ metadata: { user_id: 'opaque-user' } }, 'stream').stableScope, identity({ metadata: { user_id: ' opaque-user ' } }, 'generate').stableScope);
  for (const raw of ['', '  ', '{}', '[]', 'null', '123', JSON.stringify({ device_id: {} }), JSON.stringify({ device_id: 'a', deviceId: 'b' })]) {
    assert.equal(identity({ metadata: { user_id: raw } }, 'stream'), null);
  }
  assert.equal(messagesIdentity(body('a'), 'client:anonymous'), null);
  assert.equal(messagesIdentity(body('a'), a.legacyScope), null, 'already scoped generic callers are unchanged');
  assert.equal(messagesIdentity(body('a'), callerKeyFromRequest(request(), 'key'), { DEVIN_CONNECT_MESSAGES_IDENTITY_V2: '0' }), null);
  assert.equal(messagesIdentity(body('a'), callerKeyFromRequest(request(), 'key'), {}), null, 'rollout is opt-in');
});

it('resumes a registered new session after a stream/generate UA change with unchanged config', async () => {
  const b = body(randomUUID()), a = identity(b, 'stream'), next = identity(b, 'generate');
  const env = getSessionEnvForModel('swe-2-high');
  const session = resolveSessionId(a.stableScope, opener(), env);
  const cfg = getSessionModelConfig(a.stableScope, opener(), env);
  await issue(a.stableScope, session); commitAfterResponse(a.stableScope, [...opener(), signed()], env);
  const chosen = resolveMessagesNativeScope(next, history());
  assert.equal(chosen.scope, a.stableScope);
  const resumed = resolveSessionId(chosen.scope, history(), env);
  assert.equal(resumed, session);
  assert.equal(getSessionModelConfig(chosen.scope, history(), env).configId, cfg.configId);
  assert.doesNotThrow(() => prepareNativeThinking(params(chosen.scope, resumed, history(), { messagesIdentity: next })));
});

it('keeps a legacy session/config and learns an alias only after full origin validation', async () => {
  const b = body(randomUUID()), a = identity(b, 'original-UA'), next = identity(b, 'background-UA');
  const env = getSessionEnvForModel('swe-2-high');
  const session = resolveSessionId(a.legacyScope, opener(), env);
  const cfg = getSessionModelConfig(a.legacyScope, opener(), env);
  await issue(a.legacyScope, session); commitAfterResponse(a.legacyScope, [...opener(), signed()], env);
  // No proof binds the changed transport to the old scope yet.
  assert.equal(resolveMessagesNativeScope(next, history()).scope, next.stableScope);
  assert.throws(() => prepareNativeThinking(params(next.stableScope, session, history(), { messagesIdentity: next })), /ORIGIN_MISMATCH/);
  const candidate = resolveMessagesNativeScope(a, history());
  assert.equal(candidate.reason, 'legacy-candidate');
  const resumed = resolveSessionId(candidate.scope, history(), env);
  prepareNativeThinking(params(candidate.scope, resumed, history(), { messagesIdentity: a }));
  assert.equal(getSessionModelConfig(candidate.scope, history(), env).configId, cfg.configId);
  assert.equal(resolveMessagesNativeScope(next, history()).scope, a.legacyScope);
  const loaded = new MessagesIdentityAliases(path.join(config.dataDir, 'messages-identity-aliases.json'));
  assert.deepEqual(loaded.candidates(next), [a.legacyScope]);
  assert.doesNotThrow(() => prepareNativeThinking(params(a.legacyScope, session, history(), { messagesIdentity: next })));
});

it('does not learn aliases from altered summaries, unknown signatures, wrong account/session or mixed history', async () => {
  const b = body(randomUUID()), a = identity(b, 'original-UA'), next = identity(b, 'background-UA');
  await issue(a.legacyScope, 'session-fixture');
  for (const extra of [{ token: 'wrong' }, { sessionId: 'wrong' }]) {
    assert.throws(() => prepareNativeThinking(params(a.legacyScope, 'session-fixture', history(), { messagesIdentity: a, ...extra })));
  }
  for (const invalid of [[...opener(), signed('offline-signature', 'changed')], [...history(), signed('unknown')]]) {
    assert.throws(() => prepareNativeThinking(params(a.legacyScope, 'session-fixture', invalid, { messagesIdentity: a })));
  }
  // A selector outside the signed allowlist strips the foreign signature like
  // feature-off rather than validating it; no alias is learned either way.
  const stripped = prepareNativeThinking(params(a.legacyScope, 'session-fixture', history(), { messagesIdentity: a, model: 'swe-2-medium' }));
  assert.equal(stripped.messages.filter(m => m.role === 'assistant').flatMap(m => m.nativeThinkingBlocks || []).length, 0);
  assert.equal(resolveMessagesNativeScope(next, history()).scope, next.stableScope);
  assert.equal(resolveMessagesNativeScope(identity(body('other-user'), 'background-UA'), history()).scope,
    identity(body('other-user'), 'background-UA').stableScope);
});

it('rejects ambiguous scopes rather than picking the first matching signature', async () => {
  const a = identity(body(randomUUID()), 'ua');
  await issue(a.stableScope, 'one'); await issue(a.legacyScope, 'two');
  assert.throws(() => resolveMessagesNativeScope(a, history()), /ambiguous messages identity/);
});

it('returns an Anthropic 400 before dispatch for ambiguous identity, ignoring body-injected context', async () => {
  const b = { ...body(randomUUID()), model: 'swe-2-high', messages: [{ role: 'user', content: 'question' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'offline summary', signature: 'offline-signature' }] }, { role: 'user', content: 'continue' }],
    messagesIdentity: { stableScope: 'forged', legacyScope: 'forged' } };
  const callerKey = callerKeyFromRequest(request('ua'), 'gateway', b), id = messagesIdentity(b, callerKey);
  await issue(id.stableScope, 'one'); await issue(id.legacyScope, 'two');
  let called = false;
  __setStreamChatForTest(async function* () { called = true; yield { type: 'finish' }; });
  const result = await handleMessages(b, { callerKey });
  assert.equal(result.status, 400); assert.equal(result.body.error.type, 'invalid_request_error');
  assert.match(result.body.error.message, /ambiguous/); assert.equal(called, false);
});

it('expires idle aliases and retains the prior durable file if a write fails', () => {
  const id = identity(body(randomUUID()), 'ua');
  const file = path.join(config.dataDir, `${randomUUID()}.json`);
  const aliases = new MessagesIdentityAliases(file);
  aliases.confirm(id, id.legacyScope, 0);
  assert.deepEqual(aliases.candidates(id, NATIVE_RETENTION_MS - 1), [id.legacyScope]);
  assert.deepEqual(aliases.candidates(id, NATIVE_RETENTION_MS), []);
  const old = fs.readFileSync(file, 'utf8');
  aliases.file = config.dataDir;
  assert.throws(() => aliases.confirm(id, id.legacyScope, 1), /cannot save/);
  assert.equal(fs.readFileSync(file, 'utf8'), old);
  assert.equal(aliases.rows[0].lastUsed, 0);
});

it('fails closed on corrupt/full alias storage and persists only hashed identity fields', () => {
  const a = identity(body(randomUUID()), 'private-UA');
  const file = path.join(config.dataDir, `${randomUUID()}.json`);
  const aliases = new MessagesIdentityAliases(file, { maxRecords: 1 });
  aliases.confirm(a, a.legacyScope);
  const other = identity(body(randomUUID()), 'another-UA');
  assert.throws(() => aliases.confirm(other, other.legacyScope), /capacity/);
  assert.throws(() => aliases.confirm(a, other.legacyScope), /unverified/);
  const disk = fs.readFileSync(file, 'utf8');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (const value of ['private-UA', 'device-fixture', 'dialog-a', TOKEN, 'offline-signature']) assert.ok(!disk.includes(value));
  const diag = JSON.stringify(identityDiagnostic(a, a.legacyScope, 'verified-alias', 'history'));
  assert.ok(!diag.includes(a.legacyScope)); assert.ok(!diag.includes('private-UA'));
  fs.writeFileSync(file, '{'); assert.throws(() => new MessagesIdentityAliases(file), /cannot read/);
  fs.writeFileSync(file, '{"version":1}'); assert.throws(() => new MessagesIdentityAliases(file), /invalid messages identity aliases/);
});

it('preserves legacy session/config and alias validity across three independent processes', () => {
  const dir = fs.mkdtempSync(path.join(config.dataDir, 'identity-restart-'));
  const worker = new URL('./fixtures/messages-identity-restart-worker.mjs', import.meta.url);
  const run = action => JSON.parse(execFileSync(process.execPath, [worker.pathname, action], {
    env: { ...process.env, DATA_DIR: dir, WINDSURFAPI_SKIP_DOTENV: '1', LOG_LEVEL: 'error' }, encoding: 'utf8',
  }).trim().split('\n').at(-1));
  const seeded = run('seed'), migrated = run('migrate'), resumed = run('resume');
  assert.equal(migrated.reason, 'legacy-candidate'); assert.equal(resumed.reason, 'verified-alias');
  assert.equal(seeded.session, migrated.session); assert.equal(seeded.session, resumed.session);
  assert.equal(seeded.cfg.configId, resumed.cfg.configId); assert.equal(resumed.cfg.turn, 2);
});

function responseSink() {
  const listeners = new Map();
  return { body: '', writableEnded: false, setHeader() {}, write(s) { this.body += s; return true; },
    end(s) { if (s) this.write(s); this.writableEnded = true; for (const fn of listeners.get('close') || []) fn(); },
    on(k, fn) { if (!listeners.has(k)) listeners.set(k, []); listeners.get(k).push(fn); return this; } };
}
function contentFromSSE(s) {
  const blocks = [];
  for (const line of s.split('\n').filter(l => l.startsWith('data: {'))) {
    const ev = JSON.parse(line.slice(6));
    if (ev.type === 'content_block_start') blocks[ev.index] = structuredClone(ev.content_block);
    if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index], d = ev.delta;
      if (d.type === 'thinking_delta') b.thinking += d.thinking;
      if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
      if (d.type === 'text_delta') b.text += d.text;
    }
  }
  return blocks;
}

it('drives the real Messages→Chat→native adapter: streaming main then non-stream background, with no network', async () => {
  const meta = body(randomUUID());
  const observed = [];
  __setStreamChatForTest(async function* (p) {
    observed.push(p);
    yield { type: 'reasoning', text: 'offline summary' };
    yield { type: 'signature', reasoning_signature: `offline-signature-${observed.length}`, signatureType: 'sealed' };
    yield { type: 'content', text: 'offline answer' };
    yield { type: 'finish', reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 } };
  });
  const mainBody = { ...meta, model: 'swe-2-high', stream: true, messages: opener() };
  const main = await handleMessages(mainBody, { callerKey: callerKeyFromRequest(request('main-UA'), 'gateway', mainBody) });
  assert.equal(main.status, 200); assert.equal(main.stream, true);
  const res = responseSink(); await main.handler(res);
  assert.ok(res.body.includes('message_stop')); assert.ok(!res.body.includes('event: error'));
  const backgroundBody = { ...meta, model: 'swe-2-high', stream: false, messages: [...opener(), { role: 'assistant', content: contentFromSSE(res.body) }, { role: 'user', content: 'extract memory' }] };
  const background = await handleMessages(backgroundBody, { callerKey: callerKeyFromRequest(request('background-UA'), 'gateway', backgroundBody) });
  assert.equal(background.status, 200, JSON.stringify(background.body));
  assert.equal(observed.length, 2);
  assert.equal(observed[0].nativeThinkingScope, observed[1].nativeThinkingScope);
  assert.equal(observed[0].sessionId, observed[1].sessionId);
  assert.deepEqual(observed.map(p => p.sessionModelConfig.turn), [1, 2]);
  assert.equal(observed[0].sessionModelConfig.id, observed[1].sessionModelConfig.id);
});

it('migrates a pre-fix response through the real handler, then accepts a different-UA signed continuation', async () => {
  const meta = body(randomUUID());
  const observed = [];
  __setStreamChatForTest(async function* (p) {
    observed.push(p);
    yield { type: 'reasoning', text: 'offline summary' };
    yield { type: 'signature', reasoning_signature: `migration-signature-${observed.length}`, signatureType: 'sealed' };
    yield { type: 'content', text: `answer-${observed.length}` };
    yield { type: 'finish', reason: 'stop' };
  });
  const msgs = opener();
  process.env.DEVIN_CONNECT_MESSAGES_IDENTITY_V2 = '0';
  const firstBody = { ...meta, model: 'swe-2-high', messages: msgs };
  const first = await handleMessages(firstBody, { callerKey: callerKeyFromRequest(request('old-UA'), 'gateway', firstBody) });
  assert.equal(first.status, 200);
  msgs.push({ role: 'assistant', content: first.body.content }, { role: 'user', content: 'continue' });
  process.env.DEVIN_CONNECT_MESSAGES_IDENTITY_V2 = '1';
  const secondBody = { ...meta, model: 'swe-2-high', stream: true, messages: msgs };
  const second = await handleMessages(secondBody, { callerKey: callerKeyFromRequest(request('old-UA'), 'gateway', secondBody) });
  assert.equal(second.status, 200);
  const res = responseSink(); await second.handler(res);
  assert.ok(!res.body.includes('event: error'));
  msgs.push({ role: 'assistant', content: contentFromSSE(res.body) }, { role: 'user', content: 'extract memory' });
  const thirdBody = { ...meta, model: 'swe-2-high', messages: msgs };
  const third = await handleMessages(thirdBody, { callerKey: callerKeyFromRequest(request('new-UA'), 'gateway', thirdBody) });
  assert.equal(third.status, 200, JSON.stringify(third.body));
  assert.equal(observed.length, 3);
  assert.equal(new Set(observed.map(p => p.nativeThinkingScope)).size, 1);
  assert.equal(new Set(observed.map(p => p.sessionId)).size, 1);
  assert.deepEqual(observed.map(p => p.sessionModelConfig.turn), [1, 2, 3]);
});

it('records the existing sibling-branch limitation in both legacy and stable identity modes', async () => {
  // Identity stability does not authorize moving old signatures to a new
  // upstream session. A branch manager is explicitly outside this patch.
  for (const mode of ['0', '1']) {
    process.env.DEVIN_CONNECT_MESSAGES_IDENTITY_V2 = mode;
    const meta = body(randomUUID());
    let calls = 0;
    __setStreamChatForTest(async function* () {
      calls++;
      yield { type: 'reasoning', text: 'offline summary' };
      yield { type: 'signature', reasoning_signature: `branch-${mode}-${calls}`, signatureType: 'sealed' };
      yield { type: 'content', text: `answer-${calls}` };
      yield { type: 'finish', reason: 'stop' };
    });
    const send = async messages => {
      const b = { ...meta, model: 'swe-2-high', messages };
      return handleMessages(b, { callerKey: callerKeyFromRequest(request('same-UA'), 'gateway', b) });
    };
    const main = await send(opener()); assert.equal(main.status, 200);
    const prefix = [...opener(), { role: 'assistant', content: main.body.content }];
    const background = await send([...prefix, { role: 'user', content: 'extract memory' }]);
    assert.equal(background.status, 200);
    const sibling = await send([...prefix, { role: 'user', content: 'continue main without the background result' }]);
    assert.equal(sibling.status, 400);
    assert.match(sibling.body.error.message, /SIGNATURE_ORIGIN_MISMATCH/);
    assert.equal(calls, 2, 'an incompatible sibling never reaches the fake upstream');
  }
});
