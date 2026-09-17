import { messagesIdentity } from '../../src/messages-identity.js';
import { callerKeyFromRequest } from '../../src/caller-key.js';
import { resolveMessagesNativeScope, prepareNativeThinking, nativeThinkingEvents } from '../../src/devin-thinking.js';
import { resolveSessionId, commitAfterResponse, getSessionModelConfig, getSessionEnvForModel } from '../../src/session-continuity.js';

const action = process.argv[2];
const b = { metadata: { user_id: JSON.stringify({ device_id: 'offline-device', session_id: 'offline-dialog' }) } };
const req = { headers: { 'user-agent': action === 'resume' ? 'generate-UA' : 'stream-UA' }, socket: { remoteAddress: '127.0.0.1' } };
const identity = messagesIdentity(b, callerKeyFromRequest(req, 'offline-gateway', b));
const env = getSessionEnvForModel('swe-2-high');
const first = [{ role: 'user', content: 'offline question' }];
const assistant = { role: 'assistant', content: 'offline answer', nativeThinkingBlocks: [{ type: 'thinking', thinking: 'offline summary', signature: 'offline-signature' }] };
const messages = action === 'seed' ? first : [...first, assistant, { role: 'user', content: 'continue' }];
const selection = action === 'seed' ? { scope: identity.legacyScope, reason: 'old-version' } : resolveMessagesNativeScope(identity, messages);
const session = resolveSessionId(selection.scope, messages, env);
const cfg = getSessionModelConfig(selection.scope, messages, env);
const params = { token: 'offline-account', model: 'swe-2-high', sessionId: session, nativeThinkingScope: selection.scope, messages, env };
if (action === 'seed') {
  async function* frames() { yield { type: 'reasoning', text: 'offline summary' }; yield { type: 'signature', reasoning_signature: 'offline-signature', signatureType: 'sealed' }; yield { type: 'finish' }; }
  for await (const _ of nativeThinkingEvents(frames(), params)) {}
  commitAfterResponse(selection.scope, [...first, assistant], env);
} else prepareNativeThinking({ ...params, messagesIdentity: identity });
console.log(JSON.stringify({ session, cfg, reason: selection.reason }));
