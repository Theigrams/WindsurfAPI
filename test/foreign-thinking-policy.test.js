import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { parseFields, getAllFields, getField } from '../src/proto.js';

const env = { DEVIN_CONNECT_NATIVE_THINKING: '1',
  DEVIN_CONNECT_NATIVE_THINKING_SIGNED_MODELS: 'swe-2-high',
  DEVIN_CONNECT_NATIVE_THINKING_TEXT_MODELS: 'deepseek-v4-1-flash-high' };
const history = [{ role: 'assistant', content: 'previous answer', reasoning_content: 'private fixture summary',
  reasoning_signature: 'foreign-fixture-signature',
  nativeThinkingBlocks: [{ type: 'thinking', thinking: 'private fixture summary', signature: 'foreign-fixture-signature' }] },
  { role: 'user', content: 'continue with the answer' }];
function rows(model, flags, messages = history) {
  const wire = buildGetChatMessageRequest({ token: 'fixture-policy-account', model, messages,
    sessionId: 'fixture-session', nativeThinkingScope: 'fixture-caller', env: flags });
  return getAllFields(parseFields(wire), 3).map(f => parseFields(f.value));
}
for (const model of ['glm-5-3-flash-high', 'claude-sonnet-4-6-thinking', 'swe-2-medium', 'swe-1-7']) {
  for (const probe of ['0', '1', '9']) {
    test(`unlisted ${model} strips foreign thinking even with legacy probe=${probe}`, () => {
      const result = rows(model, { ...env, DEVIN_CONNECT_REPLAY_REASONING: probe });
      assert.ok(result.some(r => getField(r, 3, 2)?.value.toString() === 'previous answer'));
      for (const row of result) for (const field of [9, 11, 12, 18]) {
        assert.equal(getField(row, field, 2), null, `foreign thinking field ${field} reached ${model}`);
      }
    });
  }
}
test('the native signed allowlist still rejects unknown signatures before encoding', () => {
  assert.throws(() => rows('swe-2-high', env), /SIGNATURE_UNKNOWN/);
});
test('text allowlist preserves unsigned summary and drops signature/type', () => {
  const result = rows('deepseek-v4-1-flash-high', env);
  assert.ok(result.some(r => getField(r, 11, 2)?.value.toString() === 'private fixture summary'));
  for (const row of result) for (const field of [12, 18]) assert.equal(getField(row, field, 2), null);
});
test('feature-off keeps the explicitly requested legacy probe unchanged', () => {
  const result = rows('swe-1-7', { DEVIN_CONNECT_REPLAY_REASONING: '1' },
    [{ role: 'assistant', content: 'answer', reasoning_content: 'fixture summary' }]);
  assert.equal(getField(result[0], 11, 2)?.value.toString(), 'fixture summary');
});
