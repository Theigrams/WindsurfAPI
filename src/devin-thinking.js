// Opt-in native Devin thinking. Opaque signatures are never interpreted or minted.
import { createHash } from 'node:crypto';

const issued = new Map();
const TTL_MS = 30 * 60 * 1000;
const MAX_RECORDS = 500;
const MAX_BYTES = 2 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
export const nativeThinkingEnabled = (env = process.env) => env.DEVIN_CONNECT_NATIVE_THINKING === '1';
export function nativeThinkingMode(model, env = process.env) {
  if (!nativeThinkingEnabled(env)) return null;
  const includes = key => String(env[key] || '').split(',').map(s => s.trim()).filter(Boolean).includes(model);
  if (includes('DEVIN_CONNECT_NATIVE_THINKING_SIGNED_MODELS')) return 'signed';
  if (includes('DEVIN_CONNECT_NATIVE_THINKING_TEXT_MODELS')) return 'text';
  return null;
}
export function thinkingError(detail) {
  return Object.assign(new Error(`Native thinking: ${detail}`), { code: 'NATIVE_THINKING_INCOMPATIBLE', status: 400 });
}
function blocksFor(message) {
  if (Array.isArray(message.nativeThinkingBlocks)) return message.nativeThinkingBlocks;
  if (message.role === 'assistant' && (message.reasoning_content || message.reasoning || message.reasoning_signature)) {
    return [{ type: 'thinking', thinking: message.reasoning_content ?? message.reasoning ?? '', signature: message.reasoning_signature }];
  }
  return [];
}
function origin(params) {
  // A token rotation is conservatively treated as an account boundary.
  if (!params.token || !params.sessionId || typeof params.nativeThinkingScope !== 'string') {
    throw thinkingError('signed replay requires an explicit caller scope, account token and stable session.');
  }
  return hash(JSON.stringify([params.nativeThinkingScope, params.model, hash(params.token), params.sessionId]));
}
function prune(now) {
  for (const [key, entry] of issued) if (entry.expires <= now) issued.delete(key);
}
function keyFor(scope, thinking, signature) {
  return hash(JSON.stringify([scope, thinking, signature]));
}

// Called at each network attempt, after final model/account/session selection.
// Caller-supplied type/origin fields are intentionally ignored.
export function prepareNativeThinking(params, now = Date.now()) {
  const env = params.env || process.env;
  if (!nativeThinkingEnabled(env)) return params;
  const mode = nativeThinkingMode(params.model, env);
  const messages = params.messages || [];
  if (!mode) {
    if (messages.some(m => blocksFor(m).length)) throw thinkingError('history belongs to a model outside the replay allowlist.');
    return params;
  }
  if (params.continuityTrail) throw thinkingError('native replay cannot be combined with reasoning prompt injection.');
  const scope = mode === 'signed' ? origin(params) : null;
  prune(now);
  const normalized = messages.map(m => {
    const blocks = blocksFor(m);
    if (!blocks.length) return m;
    if (m.role !== 'assistant' || blocks.length !== 1 || blocks[0]?.type !== 'thinking') {
      throw thinkingError('only one ordinary thinking block per assistant is supported; redacted/interleaved blocks are not supported.');
    }
    const block = blocks[0];
    if (typeof block.thinking !== 'string' || (block.signature != null && typeof block.signature !== 'string')) {
      throw thinkingError('thinking and signature must be strings.');
    }
    if (Buffer.byteLength(block.thinking) + Buffer.byteLength(block.signature || '') > MAX_BYTES) throw thinkingError('history block exceeds the 2 MiB native thinking limit.');
    if (m.tool_calls?.length && !params.nativeToolCall) throw thinkingError('thinking tool history requires native tool calls.');
    const copy = { type: 'thinking', thinking: block.thinking };
    if (block.signature) {
      if (mode !== 'signed') throw thinkingError('signed history cannot be replayed by an unsigned model.');
      if (m.tool_calls?.length > 1) throw thinkingError('signed parallel tool history is not yet supported.');
      const record = issued.get(keyFor(scope, block.thinking, block.signature));
      if (!record) throw thinkingError('signature origin is unknown, expired, or differs in thinking/model/account/session.');
      copy.signature = block.signature;
      copy.signatureType = record.type;
    }
    return { ...m, nativeThinkingBlocks: [copy] };
  });
  return { ...params, messages: normalized };
}

// Strict path bypasses text reclassification, rescue nudges, and transparent
// attempt concatenation. Signed models buffer content until signature completion.
export async function* nativeThinkingEvents(source, params, now = () => Date.now()) {
  const mode = nativeThinkingMode(params.model, params.env || process.env);
  let thinking = '', signature = '', type = '', finish = null, sawContent = false, bytes = 0;
  const pending = [];
  const addBytes = value => {
    bytes += Buffer.byteLength(value || '', 'utf8');
    if (bytes > MAX_BYTES) throw thinkingError('response exceeds the 2 MiB native thinking buffer limit.');
  };
  const setType = value => {
    if (value == null || value === '') return;
    if (typeof value !== 'string' || (type && type !== value)) throw thinkingError('inconsistent signature type.');
    type = value;
  };
  for await (const ev of source) {
    if (params.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    if (finish) throw thinkingError('received events after the terminal event.');
    if (ev.type === 'attempt_reset') throw thinkingError('cannot combine different generation attempts.');
    if (ev.type === 'reasoning') {
      if (sawContent && ev.text) throw thinkingError('interleaved thinking is not yet supported.');
      addBytes(ev.text); thinking += ev.text;
      yield ev;
    } else if (ev.type === 'signature') {
      if (mode !== 'signed') throw thinkingError('unsigned model unexpectedly supplied a signature.');
      if (ev.thinkingId) throw thinkingError('thinking block IDs require a calibrated multi-block protocol.');
      const delta = ev.reasoning_signature || '';
      addBytes(delta); signature += delta; setType(ev.signatureType);
    } else if (ev.type === 'content') {
      if (!ev.text) continue;
      sawContent = true; addBytes(ev.text);
      if (mode === 'signed') pending.push(ev); else yield ev;
    } else if (ev.type === 'finish') {
      finish = ev;
      addBytes(JSON.stringify(ev.toolCalls || []));
      const finalSignature = ev.reasoning_signature ?? ev.signature?.text ?? '';
      if (finalSignature && signature && finalSignature !== signature) throw thinkingError('signature deltas differ from the terminal signature.');
      if (!signature && finalSignature) { addBytes(finalSignature); signature = finalSignature; }
      setType(ev.signature?.signatureType);
      if (ev.signature?.thinkingId) throw thinkingError('thinking block IDs require a calibrated multi-block protocol.');
    }
  }
  if (!finish) throw thinkingError('upstream ended without a terminal event.');
  if (params.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
  if (signature) {
    if (mode !== 'signed' || !type) throw thinkingError('signature has no verified upstream type.');
    if (finish.toolCalls?.length > 1) throw thinkingError('signed parallel tool responses are not yet supported.');
    const scope = origin(params);
    prune(now());
    const key = keyFor(scope, thinking, signature);
    const old = issued.get(key);
    if (old && old.type !== type) throw thinkingError('signature type changed for an existing block.');
    issued.delete(key);
    issued.set(key, { type, expires: now() + TTL_MS });
    while (issued.size > MAX_RECORDS) issued.delete(issued.keys().next().value);
    yield { type: 'signature', reasoning_signature: signature, signatureType: type };
  }
  for (const ev of pending) yield ev;
  yield finish;
}

export const __thinkingTesting = { clear: () => issued.clear(), size: () => issued.size, TTL_MS, MAX_RECORDS, MAX_BYTES };
