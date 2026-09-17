import { resolveSessionId, commitAfterResponse, getSessionModelConfig, getSessionEnvForModel } from '../../src/session-continuity.js';
import { nativeThinkingEvents } from '../../src/devin-thinking.js';
import { buildGetChatMessageRequest } from '../../src/devin-connect.js';
import { parseFields, getField, getAllFields } from '../../src/proto.js';

const env = getSessionEnvForModel('swe-2-high');
// Resume after an hour of inactivity as well as a fresh OS process.
if (process.argv[2] === 'replay') {
  const actualNow = Date.now;
  Date.now = () => actualNow() + 60 * 60 * 1000;
}
const history = [{ role: 'user', content: 'private-opener-fixture' }];
const assistant = { role: 'assistant', content: 'private-answer-fixture', nativeThinkingBlocks: [{ type: 'thinking', thinking: 'summary-fixture', signature: 'opaque-fixture' }] };
if (process.argv[2] === 'replay') history.push(assistant, { role: 'user', content: 'continue' });
const session = resolveSessionId('caller-fixture', history, env);
const config = getSessionModelConfig('caller-fixture', history, env);
const params = { token: 'token-fixture', model: 'swe-2-high', sessionId: session, nativeThinkingScope: 'caller-fixture', env, messages: history };
if (process.argv[2] === 'issue') {
  async function* frames() {
    yield { type: 'reasoning', text: 'summary-fixture' };
    yield { type: 'signature', reasoning_signature: 'opaque-fixture', signatureType: 'sealed' };
    yield { type: 'finish' };
  }
  for await (const ignored of nativeThinkingEvents(frames(), params)) {}
  commitAfterResponse('caller-fixture', [...history, assistant], env);
  console.log(JSON.stringify({ session, config }));
} else {
  const fields = parseFields(buildGetChatMessageRequest(params));
  const signed = getAllFields(fields, 3).map(f => parseFields(f.value)).find(f => getField(f, 12, 2));
  console.log(JSON.stringify({ session, config, summary: getField(signed, 11, 2).value.toString(), signature: getField(signed, 12, 2).value.toString() }));
}
