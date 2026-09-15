import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { nativeThinkingMode, prepareNativeThinking, nativeThinkingEvents, __thinkingTesting } from '../src/devin-thinking.js';
import { buildGetChatMessageRequest, decodeFrame, __setRequestImpl } from '../src/devin-connect.js';
import { wrapEnvelope, endOfStreamEnvelope } from '../src/connect.js';
import { getExperimental, setExperimental } from '../src/runtime-config.js';
import { _resetForTests as resetSessions } from '../src/session-continuity.js';
import { toChatCompletion, streamChatCompletion, __setStreamChatForTest } from '../src/devin-connect-openai.js';
import { handleMessages } from '../src/handlers/messages.js';
import { normalizeMessagesForCascade } from '../src/handlers/tool-emulation.js';
import { parseFields, getAllFields, getField, writeStringField, writeMessageField, writeVarintField } from '../src/proto.js';

// Structural unit fixtures only. Real opaque signatures are checked separately,
// in memory, against existing diagnostic logs; no credentials are needed here.
const thinking = ' \nPlan 中文🙂\n ';
const signature = 'opaque-unit-fixture-not-a-real-signature';
const env = { DEVIN_CONNECT_NATIVE_THINKING: '1', DEVIN_CONNECT_NATIVE_THINKING_SIGNED_MODELS: 'swe-2-high', DEVIN_CONNECT_NATIVE_THINKING_TEXT_MODELS: 'glm-5-2,glm-5-2-max' };
const base = { token: 'offline-account-a', model: 'swe-2-high', sessionId: 'session-a', nativeThinkingScope: 'caller-a', nativeToolCall: true, messages: [], env };
const block = () => ({ type: 'thinking', thinking, signature });
const assistant = () => ({ role: 'assistant', content: 'checking', nativeThinkingBlocks: [block()] });
const tool = id => ({ id, type: 'function', function: { name: 'lookup', arguments: '{}' } });
async function* events(list) { yield* list; }
async function collect(list, params = base, now) {
  const out = [];
  for await (const ev of nativeThinkingEvents(events(list), params, now)) out.push(ev);
  return out;
}
const signedEvents = () => [
  { type: 'reasoning', text: thinking },
  { type: 'content', text: 'OK' }, // signature intentionally arrives late
  { type: 'signature', reasoning_signature: signature.slice(0, 7) },
  { type: 'signature', reasoning_signature: signature.slice(7) },
  { type: 'signature', reasoning_signature: '', signatureType: 'sealed' },
  { type: 'finish', reason: 'stop', reasoning_signature: signature, signature: { text: signature, signatureType: 'sealed' } },
];
function wire(params) {
  return getAllFields(parseFields(buildGetChatMessageRequest(params)), 3).map(f => parseFields(f.value));
}
const str = (fields, tag) => getField(fields, tag, 2)?.value.toString('utf8');
function fakeRes() {
  const handlers = new Map();
  return { body: '', writableEnded: false, write(c) { this.body += String(c); return true; }, end(c) { if (c) this.write(c); this.writableEnded = true; for (const fn of handlers.get('close') || []) fn(); }, on(k, fn) { if (!handlers.has(k)) handlers.set(k, []); handlers.get(k).push(fn); return this; } };
}
function parseEvents(body) { return body.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6))); }
function assemble(list) {
  const content = [];
  for (const e of list) {
    if (e.type === 'content_block_start') content[e.index] = structuredClone(e.content_block);
    if (e.type === 'content_block_delta') {
      const b = content[e.index], d = e.delta;
      if (d.type === 'thinking_delta') b.thinking += d.thinking;
      if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
      if (d.type === 'text_delta') b.text += d.text;
      if (d.type === 'input_json_delta') b._args = (b._args || '') + d.partial_json;
    }
  }
  return content.map(b => { if (b._args) { b.input = JSON.parse(b._args); delete b._args; } return b; });
}
let saved;
beforeEach(() => { saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env); __thinkingTesting.clear(); });
afterEach(() => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v; __setStreamChatForTest(null); __setRequestImpl(null); __thinkingTesting.clear(); });

describe('Native thinking policy and wire fidelity', () => {
  it('is off by default and requires an explicit exact selector allowlist', () => {
    assert.equal(nativeThinkingMode('swe-2-high', {}), null);
    assert.equal(nativeThinkingMode('swe-2-max', env), null);
    assert.equal(nativeThinkingMode('swe-2-high', env), 'signed');
    assert.equal(nativeThinkingMode('glm-5-2-max', env), 'text');
    assert.equal(nativeThinkingMode('swe-2-high', { DEVIN_CONNECT_NATIVE_THINKING: '1' }), null);
  });
  it('keeps source signature, type, text whitespace and one tool on a single wire message', async () => {
    await collect(signedEvents());
    const params = { ...base, messages: [{ ...assistant(), tool_calls: [tool('a')] }, { role: 'tool', tool_call_id: 'a', content: '7' }] };
    const before = structuredClone(params);
    const rows = wire(params);
    assert.equal(rows.length, 2);
    assert.equal(str(rows[0], 3), 'checking'); assert.equal(str(rows[0], 11), thinking);
    assert.equal(str(rows[0], 12), signature); assert.equal(str(rows[0], 18), 'sealed');
    assert.ok(getField(rows[0], 6, 2)); assert.equal(str(rows[1], 7), 'a');
    assert.deepEqual(params, before);
  });
  it('replays unsigned thinking-only messages without promotion or trimming', () => {
    const rows = wire({ ...base, model: 'glm-5-2-max', messages: [{ role: 'assistant', content: '', reasoning_content: thinking }] });
    assert.equal(rows.length, 1); assert.equal(str(rows[0], 11), thinking);
    assert.equal(str(rows[0], 12), undefined); assert.equal(str(rows[0], 18), undefined);
  });
  it('never coalesces distinct thinking turns', () => {
    const rows = wire({ ...base, model: 'glm-5-2-max', messages: [1, 2, 3].map(i => ({ role: 'assistant', content: 'ok', reasoning_content: String(i) })) });
    assert.deepEqual(rows.map(r => str(r, 11)), ['1', '2', '3']);
  });
  for (const [name, change] of Object.entries({ model: { model: 'swe-2-max' }, account: { token: 'account-b' }, session: { sessionId: 'b' }, caller: { nativeThinkingScope: 'b' } })) {
    it(`rejects signed replay across ${name}`, async () => {
      await collect(signedEvents());
      assert.throws(() => wire({ ...base, ...change, messages: [assistant()] }), /Native thinking/);
    });
  }
  it('rejects unknown, expired, mutated and restart-lost signature metadata', async () => {
    const params = { ...base, messages: [assistant()] };
    assert.throws(() => prepareNativeThinking(params), /unknown/);
    const now = Date.now(); await collect(signedEvents(), base, () => now);
    assert.throws(() => prepareNativeThinking({ ...base, messages: [{ ...assistant(), nativeThinkingBlocks: [{ ...block(), thinking: thinking.trim() }] }] }), /unknown/);
    assert.throws(() => prepareNativeThinking(params, now + __thinkingTesting.TTL_MS), /unknown/);
    await collect(signedEvents()); __thinkingTesting.clear();
    assert.throws(() => prepareNativeThinking(params), /unknown/);
  });
  it('does not trust supplied signature type or origin claims', async () => {
    await collect(signedEvents());
    const rows = wire({ ...base, messages: [{ ...assistant(), nativeThinkingBlocks: [{ ...block(), signatureType: 'forged-type', origin: base }] }] });
    assert.equal(str(rows[0], 18), 'sealed');
  });
  it('rejects switching between two explicitly allowed signed selectors before transport', async () => {
    await collect(signedEvents());
    let transports = 0;
    __setStreamChatForTest(async function* () { transports++; yield { type: 'finish' }; });
    await assert.rejects(toChatCompletion({ ...base, model: 'swe-2-max', env: { ...env, DEVIN_CONNECT_NATIVE_THINKING_SIGNED_MODELS: 'swe-2-high,swe-2-max' }, messages: [assistant()] }), /unknown/);
    assert.equal(transports, 0);
  });
  it('rejects missing stable session and prompt injection', () => {
    assert.throws(() => prepareNativeThinking({ ...base, sessionId: '' }), /stable session/);
    assert.throws(() => prepareNativeThinking({ ...base, continuityTrail: 'checkpoint' }), /injection/);
  });
  it('rejects unsupported redacted and multiple thinking blocks', () => {
    for (const blocks of [[block(), block()], [{ type: 'redacted_thinking', data: 'opaque' }], [null]]) {
      assert.throws(() => prepareNativeThinking({ ...base, messages: [{ ...assistant(), nativeThinkingBlocks: blocks }] }), /only one/);
    }
  });
  it('rejects signed parallel calls before splitting, and preserves unsigned pairing without duplicates', async () => {
    await collect(signedEvents());
    const results = [{ role: 'tool', tool_call_id: 'b', content: '2' }, { role: 'tool', tool_call_id: 'a', content: '1' }];
    const normalize = messages => normalizeMessagesForCascade(messages, [], { nativeStructured: true, stripOrphans: true, injectUserPreamble: false });
    const signed = normalize([{ ...assistant(), tool_calls: [tool('a'), tool('b')] }, ...results]);
    assert.equal(signed[0].tool_calls.length, 2);
    assert.throws(() => wire({ ...base, messages: signed }), /parallel/);
    const unsigned = normalize([{ ...assistant(), nativeThinkingBlocks: [{ type: 'thinking', thinking }], tool_calls: [tool('a'), tool('b')] }, ...results]);
    const rows = wire({ ...base, model: 'glm-5-2-max', messages: unsigned });
    assert.equal(rows.filter(r => str(r, 11)).length, 1);
    assert.deepEqual(rows.filter(r => str(r, 7)).map(r => str(r, 7)), ['a', 'b']);
  });
  it('reads signature bytes and a separately arriving string type, including repeated signature fields', () => {
    const opts = { signatureTags: { signature: 10, type: 21, typeWire: 2 } };
    const decoded = decodeFrame(Buffer.concat([writeStringField(10, 'part-a'), writeStringField(10, 'part-b')]), opts);
    assert.equal(decoded.signature.text, 'part-apart-b');
    const type = decodeFrame(writeStringField(21, 'sealed'), opts);
    assert.deepEqual(type.signature, { text: '', signatureType: 'sealed' });
    assert.throws(() => decodeFrame(writeMessageField(10, Buffer.from([255])), opts), /UTF-8/);
  });
});

describe('Native thinking response state machine', () => {
  it('reorders late signature before content, accumulates deltas once and retains separate type', async () => {
    const out = await collect(signedEvents());
    assert.deepEqual(out.map(e => e.type), ['reasoning', 'signature', 'content', 'finish']);
    assert.equal(out[1].reasoning_signature, signature); assert.equal(out[1].signatureType, 'sealed');
    assert.equal(__thinkingTesting.size(), 1);
  });
  it('preserves signature-only responses', async () => {
    await collect(signedEvents().filter(e => e.type !== 'reasoning' && e.type !== 'content'));
    const rows = wire({ ...base, messages: [{ ...assistant(), content: '', nativeThinkingBlocks: [{ ...block(), thinking: '' }] }] });
    assert.equal(str(rows[0], 12), signature);
  });
  it('keeps unsigned replies unsigned, even on a signed-capable model', async () => {
    const out = await collect([{ type: 'reasoning', text: thinking }, { type: 'finish', reason: 'stop' }]);
    assert.equal(out.some(e => e.type === 'signature'), false);
    assert.equal(__thinkingTesting.size(), 0);
  });
  for (const [name, list] of [
    ['interleaving', [{ type: 'content', text: 'a' }, { type: 'reasoning', text: 'b' }]],
    ['missing finish', [{ type: 'reasoning', text: 'a' }]],
    ['attempt reset', [{ type: 'attempt_reset' }]],
    ['unknown type', [{ type: 'signature', reasoning_signature: signature }, { type: 'finish' }]],
    ['type change', [{ type: 'signature', signatureType: 'sealed' }, { type: 'signature', signatureType: 'other' }]],
    ['terminal mismatch', [{ type: 'signature', reasoning_signature: signature, signatureType: 'sealed' }, { type: 'finish', reasoning_signature: 'different' }]],
    ['overflow', [{ type: 'content', text: 'x'.repeat(__thinkingTesting.MAX_BYTES + 1) }]],
    ['parallel signed response', [...signedEvents().slice(0, -1), { type: 'finish', toolCalls: [tool('a'), tool('b')] }]],
  ]) it(`fails closed on ${name}`, async () => { await assert.rejects(collect(list), /Native thinking/); assert.equal(__thinkingTesting.size(), 0); });
  it('does not register aborted responses', async () => {
    const ac = new AbortController(); ac.abort();
    await assert.rejects(collect(signedEvents(), { ...base, signal: ac.signal }), /Aborted/);
    assert.equal(__thinkingTesting.size(), 0);
  });
  it('does not save partial output on an upstream error or retry an emitted attempt', async () => {
    let attempts = 0;
    __setStreamChatForTest(async function* () { attempts++; yield { type: 'reasoning', text: thinking }; throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); });
    const sent = []; await assert.rejects(streamChatCompletion(base, c => sent.push(c)), /reset/);
    assert.equal(attempts, 1); assert.equal(__thinkingTesting.size(), 0);
    assert.equal(sent.some(c => c.choices?.[0]?.delta?.reasoning_signature), false);
  });
  it('bounds registry capacity and rejects the evicted oldest entry', async () => {
    for (let i = 0; i < __thinkingTesting.MAX_RECORDS + 1; i++) {
      await collect([{ type: 'signature', reasoning_signature: `unit-${i}`, signatureType: 'sealed' }, { type: 'finish' }]);
    }
    assert.equal(__thinkingTesting.size(), __thinkingTesting.MAX_RECORDS);
    assert.throws(() => prepareNativeThinking({ ...base, messages: [{ role: 'assistant', content: '', nativeThinkingBlocks: [{ type: 'thinking', thinking: '', signature: 'unit-0' }] }] }), /unknown/);
  });
});

describe('Full HTTP handler chain with only HTTPS transport mocked', () => {
  for (const model of ['swe-2-high', 'glm-5.2']) for (const stream of [false, true]) for (const withTool of [false, true]) {
    const signed = model === 'swe-2-high';
    it(`replays real decoded frames through routing, session commit and wire (model=${model}, stream=${stream}, tool=${withTool})`, async () => {
      const flags = { DEVIN_CONNECT: '1', DEVIN_CONNECT_TOKEN: 'offline-http-transport-only', DEVIN_CONNECT_SESSION_REUSE: '1', DEVIN_CONNECT_MODEL_CONFIG_STABLE: '1', DEVIN_CONNECT_SESSION_MODELS: 'swe-2-high' };
      const old = Object.fromEntries(Object.keys(flags).map(k => [k, process.env[k]]));
      const experimental = getExperimental();
      Object.assign(process.env, flags); setExperimental({ nativeToolCall: true }); resetSessions();
      const requests = [];
      __setRequestImpl((_opts, cb) => {
        const req = new EventEmitter(); req.destroyed = false; req.setTimeout = () => req;
        req.write = data => requests.push(parseFields(data.subarray(5)));
        req.destroy = () => { req.destroyed = true; };
        req.end = () => {
          const res = new EventEmitter(); res.statusCode = 200; cb(res);
          setImmediate(() => {
            const frames = [writeStringField(9, thinking), writeStringField(3, 'OK')];
            if (signed) frames.push(writeStringField(21, 'sealed'), writeStringField(10, signature.slice(0, 7)), writeStringField(10, signature.slice(7)));
            if (withTool) frames.push(writeMessageField(6, Buffer.concat([writeStringField(1, 'tool-a'), writeStringField(2, 'lookup'), writeStringField(3, '{}')])));
            frames.push(writeVarintField(5, 2));
            for (const frame of frames) { if (req.destroyed) return; res.emit('data', wrapEnvelope(frame, { compress: false })); }
            res.emit('data', endOfStreamEnvelope()); res.emit('end');
          });
        };
        return req;
      });
      try {
        const messages = [{ role: 'user', content: 'Diagnostic.' }];
        const body = { model, stream, messages, ...(withTool ? { tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }] } : {}) };
        const context = { callerKey: 'native-full-chain' };
        const response = await handleMessages(body, context);
        assert.equal(response.status, 200);
        let content;
        if (stream) {
          const res = fakeRes(); await response.handler(res);
          const es = parseEvents(res.body); assert.equal(es.some(e => e.type === 'error'), false);
          content = assemble(es);
        } else content = response.body.content;
        assert.deepEqual(content[0], signed ? block() : { type: 'thinking', thinking });
        messages.push({ role: 'assistant', content }, { role: 'user', content: withTool ? [{ type: 'tool_result', tool_use_id: 'tool-a', content: '7' }] : 'Continue.' });
        const second = await handleMessages({ ...body, stream: false, messages }, context);
        assert.equal(second.status, 200, JSON.stringify(second.body.error));
        assert.equal(requests.length, 2);
        if (signed) assert.equal(str(requests[0], 16), str(requests[1], 16));
        const rows = getAllFields(requests[1], 3).map(f => parseFields(f.value));
        const history = rows.filter(r => str(r, 11)); assert.equal(history.length, 1);
        assert.equal(str(history[0], 11), thinking); assert.equal(str(history[0], 12), signed ? signature : undefined); assert.equal(str(history[0], 18), signed ? 'sealed' : undefined);
        if (withTool) assert.ok(rows.some(r => str(r, 7) === 'tool-a'));
      } finally {
        setExperimental(experimental); resetSessions();
        for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k] = v;
      }
    });
  }
});

describe('Anthropic -> adapter -> wire -> response -> next tool request', () => {
  for (const stream of [false, true]) for (const withTool of [false, true]) {
    it(`round-trips signed blocks through real functions (stream=${stream}, tool=${withTool})`, async () => {
      const requests = [];
      __setStreamChatForTest(async function* (params) {
        requests.push(wire(params));
        const ev = signedEvents();
        if (withTool) ev[ev.length - 1].toolCalls = [{ id: 'call-a', name: 'lookup', arguments: '{}' }];
        yield* ev;
      });
      const context = { async handleChatCompletions(body) {
        const messages = normalizeMessagesForCascade(body.messages, body.tools || [], { nativeStructured: true, stripOrphans: true, injectUserPreamble: false });
        const params = { ...base, messages };
        if (!body.stream) return toChatCompletion(params);
        return { status: 200, stream: true, async handler(res) { await streamChatCompletion(params, c => res.write(`data: ${JSON.stringify(c)}\n\n`)); res.end('data: [DONE]\n\n'); } };
      } };
      const messages = [{ role: 'user', content: 'Run diagnostic.' }];
      const first = await handleMessages({ model: base.model, messages, stream }, context);
      let content;
      if (stream) {
        const res = fakeRes(); await first.handler(res); const es = parseEvents(res.body); content = assemble(es);
        const sigIndex = es.findIndex(e => e.delta?.type === 'signature_delta');
        const closeIndex = es.findIndex(e => e.type === 'content_block_stop');
        assert.ok(sigIndex >= 0 && sigIndex < closeIndex);
      } else content = first.body.content;
      assert.deepEqual(content[0], block());
      messages.push({ role: 'assistant', content }, { role: 'user', content: withTool ? [{ type: 'tool_result', tool_use_id: 'call-a', content: '7' }] : 'Continue.' });
      await handleMessages({ model: base.model, messages, stream: false }, context);
      const history = requests[1].filter(r => Number(getField(r, 2, 0)?.value) === 2);
      assert.equal(history.length, 1); assert.equal(str(history[0], 11), thinking);
      assert.equal(str(history[0], 12), signature); assert.equal(str(history[0], 18), 'sealed');
      if (withTool) assert.equal(str(requests[1].find(r => str(r, 7)), 7), 'call-a');
    });
  }
  it('does not turn a thinking-only reply into content or retry/rescue it', async () => {
    let attempts = 0;
    __setStreamChatForTest(async function* () { attempts++; yield { type: 'reasoning', text: thinking }; yield { type: 'finish', reason: 'stop' }; });
    const result = await toChatCompletion({ ...base, model: 'glm-5-2-max', tools: [{ type: 'function', function: { name: 'lookup' } }] });
    assert.equal(attempts, 1); assert.equal(result.body.choices[0].message.content, '');
    assert.equal(result.body.choices[0].message.reasoning_content, thinking);
  });
});
