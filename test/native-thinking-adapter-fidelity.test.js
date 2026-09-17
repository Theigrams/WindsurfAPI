import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { toChatCompletion, streamChatCompletion, __setStreamChatForTest } from '../src/devin-connect-openai.js';
import { __thinkingTesting } from '../src/devin-thinking.js';

afterEach(() => { __setStreamChatForTest(null); __thinkingTesting.clear(); });

test('Cline compatibility preserves the same signed tool arguments in stream and generate', async () => {
  const args = '  {"key":"A"} \n';
  const params = { token: 'fixture-adapter-account', nativeThinkingScope: 'fixture-caller', sessionId: 'fixture-session',
    model: 'swe-2-high', nativeToolCall: true, messages: [],
    env: { DEVIN_CONNECT_NATIVE_THINKING: '1', DEVIN_CONNECT_NATIVE_THINKING_SIGNED_MODELS: 'swe-2-high' } };
  __setStreamChatForTest(async function* () {
    yield { type: 'reasoning', text: 'fixture summary' };
    yield { type: 'signature', reasoning_signature: 'fixture-signature', signatureType: 'sealed' };
    yield { type: 'finish', reason: 'tool_calls', toolCalls: [{ id: 'lookup-a', name: 'lookup', arguments: args }] };
  });
  const generated = await toChatCompletion(params, { clineCompat: true });
  const chunks = [];
  await streamChatCompletion(params, chunk => chunks.push(chunk), { clineCompat: true });
  const streamedArgs = chunks.flatMap(c => c.choices || []).flatMap(c => c.delta?.tool_calls || [])
    .map(c => c.function?.arguments || '').join('');
  assert.equal(generated.body.choices[0].message.tool_calls[0].function.arguments, args);
  assert.equal(streamedArgs, args, 'a signed native turn must not pass through the legacy argument repair shim');
});
