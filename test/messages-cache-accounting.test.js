import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages, openAIToAnthropic } from '../src/handlers/messages.js';

const policy = { breakpointCount: 1, estCacheCreationTokens: 102353, minCacheablePrefix: 1024 };
const convert = usage => openAIToAnthropic({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage }, 'swe-1-7', 'test', policy).usage;

test('explicit zero cache counters are authoritative despite a large cache policy', () => {
  const u = convert({ prompt_tokens: 85750, completion_tokens: 884, prompt_tokens_details: { cached_tokens: 83008 }, cache_creation_input_tokens: 0 });
  assert.equal(u.input_tokens, 2742);
  assert.equal(u.cache_read_input_tokens, 83008);
  assert.equal(u.cache_creation_input_tokens, 0);
  const zero = convert({ prompt_tokens: 85750, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(zero.input_tokens, 85750);
  assert.equal(zero.cache_creation_input_tokens, 0);
});

test('missing cache fields never manufacture writes or subtract from measured input', () => {
  const u = convert({ prompt_tokens: 15000, completion_tokens: 20 });
  assert.equal(u.input_tokens, 15000);
  assert.equal(u.cache_creation_input_tokens, 0);
  assert.equal(convert({}).cache_creation_input_tokens, 0);
});

test('real cache writes stay separate from fresh input and reads', () => {
  const u = convert({ prompt_tokens: 1100, prompt_tokens_details: { cached_tokens: 1000 }, cache_creation_input_tokens: 200 });
  assert.equal(u.input_tokens, 100);
  assert.equal(u.cache_creation_input_tokens, 200);
  assert.equal(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, 1300);
});

test('streaming start cannot contaminate a relay that only merges nonzero terminal values', async () => {
  const result = await handleMessages({ model: 'swe-1-7', stream: true,
    system: [{ type: 'text', text: 'cached prefix '.repeat(12000), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'ok' }] }, {
    async handleChatCompletions() { return { status: 200, stream: true, async handler(res) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 85750, completion_tokens: 884, prompt_tokens_details: { cached_tokens: 83008 }, cache_creation_input_tokens: 0 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    } }; }
  });
  const res = { body: '', write(x) { this.body += x; return true; }, end(x='') { this.body += x; }, on() { return this; }, once() { return this; }, setHeader() {}, writeHead() {}, flushHeaders() {} };
  await result.handler(res);
  const events = res.body.split('\n').filter(x => x.startsWith('data: {')).map(x => JSON.parse(x.slice(6)));
  const start = events.find(x => x.type === 'message_start').message.usage;
  const end = events.find(x => x.type === 'message_delta').usage;
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) assert.equal(start[key], 0);
  const merged = { ...start };
  for (const [k,v] of Object.entries(end)) if (v) merged[k] = v;
  assert.equal(merged.input_tokens + merged.cache_read_input_tokens + merged.cache_creation_input_tokens, 85750);
  assert.equal(merged.cache_creation_input_tokens, 0);
});
