import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { normalizeMessagesForCascade } from '../src/handlers/tool-emulation.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';

const call = id => ({ id, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ id }) } });
const assistant = (...ids) => ({ role: 'assistant', content: null, tool_calls: ids.map(call) });
const result = (id, content = `value-${id}`) => ({ role: 'tool', tool_call_id: id, content });
const str = (fields, tag) => getField(fields, tag, 2)?.value.toString('utf8');
function wire(messages, options = {}) {
  // Exercise the production normalization-to-wire boundary. Upstream owns
  // pairing now; the protobuf encoder must not contain a second implementation.
  const history = [{ role: 'system', content: 'Answer briefly.' }, ...messages];
  const normalized = options.nativeToolCall === false ? history
    : normalizeMessagesForCascade(history, [], {
      nativeStructured: true, stripOrphans: true, injectUserPreamble: false,
    });
  const bytes = buildGetChatMessageRequest({
    token: 'test-token', model: 'swe-2-high', nativeToolCall: true, env: {},
    messages: normalized, ...options,
  });
  return getAllFields(parseFields(bytes), 3).map(({ value }) => {
    const fields = parseFields(value);
    const tool = getField(fields, 6, 2);
    const tc = tool && parseFields(tool.value);
    return {
      role: Number(getField(fields, 2, 0)?.value),
      text: str(fields, 3), callId: tc && str(tc, 1), name: tc && str(tc, 2),
      args: tc && str(tc, 3), resultId: str(fields, 7), reasoning: str(fields, 11),
      images: getAllFields(fields, 10).map(f => f.value.toString('hex')),
    };
  });
}
const order = rows => rows.map(r => r.callId ? `call:${r.callId}` : r.resultId ? `result:${r.resultId}` : `${r.role}:${r.text}`);

describe('Devin native parallel tool history', () => {
  it('pairs two calls with their results without changing the input history', () => {
    const messages = [assistant('a', 'b'), result('a'), result('b')];
    const before = structuredClone(messages);
    const rows = wire(messages);
    assert.deepEqual(order(rows), ['call:a', 'result:a', 'call:b', 'result:b']);
    assert.equal(rows[0].name, 'lookup');
    assert.equal(rows[0].args, '{"id":"a"}');
    assert.equal(rows[1].text, 'value-a');
    assert.equal(rows[3].text, 'value-b');
    assert.deepEqual(messages, before);
  });

  it('pairs three out-of-order results by ID, not their array position', () => {
    assert.deepEqual(order(wire([assistant('a', 'b', 'c'), result('c'), result('a'), result('b')])),
      ['call:a', 'result:a', 'call:b', 'result:b', 'call:c', 'result:c']);
  });

  it('preserves leading assistant text, reasoning and later user text', () => {
    const msg = { ...assistant('a', 'b'), content: 'Checking both.', reasoning_content: 'Reasoning.' };
    const rows = wire([msg, result('b'), result('a'), { role: 'user', content: 'Continue.' }],
      { env: { DEVIN_CONNECT_REPLAY_REASONING: '1' } });
    assert.deepEqual(order(rows), ['2:Checking both.', 'call:a', 'result:a', 'call:b', 'result:b', '1:Continue.']);
    assert.deepEqual(rows.filter(r => r.role === 2).map(r => r.reasoning), ['Reasoning.', 'Reasoning.', undefined]);
  });

  it('preserves multimodal and empty tool results through the existing encoder', () => {
    const image = result('b', [{ type: 'text', text: 'Image result' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
    const baseline = wire([assistant('b'), image])[1];
    const rows = wire([assistant('a', 'b'), result('a', ''), image]);
    assert.equal(rows[1].text, '[tool result]');
    assert.deepEqual(rows[3], baseline);
    assert.equal(rows[3].images.length, 1);
  });

  it('scopes matching to each turn even when later turns reuse IDs', () => {
    const rows = wire([assistant('a', 'b'), result('a', 'first-a'), result('b', 'first-b'),
      assistant('a', 'b'), result('b', 'second-b'), result('a', 'second-a')]);
    assert.deepEqual(order(rows), ['call:a', 'result:a', 'call:b', 'result:b', 'call:a', 'result:a', 'call:b', 'result:b']);
    assert.deepEqual(rows.filter(r => r.resultId).map(r => r.text), ['first-a', 'first-b', 'second-a', 'second-b']);
  });

  it('leaves single-tool history unchanged', () => {
    assert.deepEqual(order(wire([assistant('a'), result('a')])), ['call:a', 'result:a']);
  });

  for (const [name, messages, expected] of [
    ['missing result', [assistant('a', 'b'), result('a')], ['call:a', 'result:a', 'call:b']],
    ['duplicate result ID', [assistant('a', 'b'), result('a'), result('a')], ['call:a', 'result:a', 'call:b', 'result:a']],
    ['unknown result ID', [assistant('a', 'b'), result('a'), result('x')], ['call:a', 'result:a', 'call:b']],
    ['extra result', [assistant('a', 'b'), result('a'), result('b'), result('x')], ['call:a', 'result:a', 'call:b', 'result:b']],
    ['duplicate call ID', [assistant('a', 'a'), result('a'), result('a')], ['call:a', 'result:a', 'call:a', 'result:a']],
    ['user boundary', [assistant('a', 'b'), result('a'), { role: 'user', content: 'Pause.' }, result('b')], ['call:a', 'result:a', 'call:b', '1:Pause.', 'result:b']],
    ['system boundary', [assistant('a', 'b'), result('a'), { role: 'system', content: 'Pause.' }, result('b')], ['call:a', 'result:a', 'call:b', 'result:b']],
    ['pending calls', [assistant('a', 'b')], ['call:a', 'call:b']],
  ]) {
    it(`preserves pending calls and boundaries while normalizing ${name}`, () => {
      const before = structuredClone(messages);
      assert.deepEqual(order(wire(messages)), expected);
      assert.deepEqual(messages, before);
    });
  }

  it('does not reorder or natively encode history when native tools are off', () => {
    const rows = wire([assistant('a', 'b'), result('b'), result('a')], { nativeToolCall: false });
    assert.ok(rows.every(r => !r.callId && !r.resultId));
    assert.deepEqual(rows.slice(-2).map(r => r.text), ['[tool result for b]: value-b', '[tool result for a]: value-a']);
  });
});
