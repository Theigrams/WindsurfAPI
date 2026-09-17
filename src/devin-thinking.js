// Opt-in native Devin thinking. Opaque signatures are never interpreted or minted.
import fs from 'node:fs';
import path from 'node:path';
import { config, log } from './config.js';
import { NativeThinkingRegistry, nativeOrigin, MAX_NATIVE_RECORDS } from './native-thinking-registry.js';
import { NATIVE_RETENTION_MS } from './native-thinking-storage.js';
import { createHash } from 'node:crypto';
import { messagesIdentityAliases, identityDiagnostic } from './messages-identity.js';

const registryFile = path.join(config.dataDir, 'native-thinking-signatures.json');
let registry;
const getRegistry = () => registry ||= new NativeThinkingRegistry(registryFile);
const TTL_MS = NATIVE_RETENTION_MS;
const MAX_RECORDS = MAX_NATIVE_RECORDS;
const MAX_BYTES = 2 * 1024 * 1024;
// Adapter-only role provenance for session identity. A Symbol cannot be supplied
// in JSON or leak into serialized client/upstream messages.
export const nativeSessionRole = Symbol('nativeSessionRole');
export function nativeSessionHistory(messages) {
  return messages.map(m => ['system', 'developer'].includes(m[nativeSessionRole])
    ? { ...m, role: m[nativeSessionRole] } : m);
}
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
export function hasSignedThinking(message) {
  return message?.role === 'assistant' && blocksFor(message).some(b => b?.signature);
}

// Restore the feature-off invariant outside the replay allowlists: foreign
// signature metadata is stripped before legacy interleave/normalize so signed
// history from another provider cannot alter the wire, trip signed-batch
// validation, or reach an upstream that would verify it. 'text' selectors keep
// unsigned thinking text; unlisted selectors drop native metadata entirely.
export function stripForeignSignedThinking(messages, mode) {
  if (mode === 'signed' || !Array.isArray(messages)) return messages;
  return messages.map(m => {
    if (mode === 'text') {
      if (!m.reasoning_signature && !m.nativeThinkingBlocks?.some(b => b?.signature || b?.signatureType)) return m;
      const { reasoning_signature: _sig, ...rest } = m;
      if (!rest.nativeThinkingBlocks) return rest;
      return { ...rest, nativeThinkingBlocks: rest.nativeThinkingBlocks.map(({ signature: _s, signatureType: _t, ...b }) => b) };
    }
    if (!Object.hasOwn(m, 'nativeThinkingBlocks') && !Object.hasOwn(m, 'reasoning_signature')) return m;
    const { nativeThinkingBlocks: _blocks, reasoning_signature: _sig, ...legacy } = m;
    return legacy;
  });
}

export function resolveMessagesNativeScope(identity, messages, aliases = messagesIdentityAliases()) {
  const signatures = messages.filter(m => m?.role === 'assistant').flatMap(blocksFor)
    .map(b => b?.signature).filter(s => typeof s === 'string' && s);
  if (!signatures.length) return { scope: identity.stableScope, reason: 'stable' };
  const candidates = [...new Set([identity.stableScope, identity.legacyScope, ...aliases.candidates(identity)])];
  const callers = getRegistry().callersForSignatures(signatures);
  const matching = candidates.filter(scope => callers.has(createHash('sha256').update(scope).digest('hex')));
  if (matching.length > 1) throw thinkingError('ambiguous messages identity; continue with the original client context.');
  const scope = matching[0] || identity.stableScope;
  return { scope, reason: !matching.length ? 'unregistered-scope' : scope === identity.stableScope ? 'stable' : scope === identity.legacyScope ? 'legacy-candidate' : 'verified-alias' };
}

// A signed assistant turn is one protocol message: repeated #6 tool calls share
// ONE #11 summary / #12 signature / #18 type. Never clone its signature onto
// the legacy call/result interleaving path. Only reorder adjacent results by ID.
// Validate before orphan stripping so malformed signed batches cannot be silently
// rewritten into apparently valid history. Also used by the direct wire API.
export function normalizeSignedToolHistory(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (!hasSignedThinking(m) || !(m.tool_calls?.length > 1)) continue;
    const ids = validateParallelCallIds(m.tool_calls);
    const results = new Map();
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === 'tool') {
      const result = messages[j++];
      if (!ids.includes(result.tool_call_id) || results.has(result.tool_call_id)) {
        throw thinkingError('signed tool results must reference each parallel tool-call ID exactly once.');
      }
      results.set(result.tool_call_id, result);
    }
    if (results.size !== ids.length) {
      throw thinkingError('signed parallel tool history requires all results before the next conversation turn.');
    }
    out.push(...ids.map(id => results.get(id)));
    i = j - 1;
  }
  return out;
}
function origin(params) {
  // A token rotation is conservatively treated as an account boundary.
  if (!params.token || !params.sessionId || typeof params.nativeThinkingScope !== 'string' || !params.nativeThinkingScope) {
    throw thinkingError('signed replay requires an explicit caller scope, account token and stable session.');
  }
  return nativeOrigin(params);
}
function validateParallelCallIds(calls) {
  const ids = calls.map(tc => tc?.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw thinkingError('parallel tool calls require nonempty, unique tool-call IDs.');
  }
  return ids;
}

// Called at each network attempt, after final model/account/session selection.
// Caller-supplied type/origin fields are intentionally ignored.
export function prepareNativeThinking(params, now = Date.now(), { renew = true } = {}) {
  const env = params.env || process.env;
  if (!nativeThinkingEnabled(env)) return params;
  const mode = nativeThinkingMode(params.model, env);
  const messages = params.messages || [];
  if (!mode) {
    // Capturing Anthropic history happens before final model resolution. Keep
    // unlisted selectors on the exact feature-off path: foreign signature
    // material is stripped rather than rejected, so mixed-provider histories
    // cannot trip signed-batch validation or reach a verifying upstream.
    return { ...params, messages: stripForeignSignedThinking(messages, mode) };
  }
  if (params.continuityTrail) throw thinkingError('native replay cannot be combined with reasoning prompt injection.');
  const scope = mode === 'signed' ? origin(params) : null;
  const verifiedKeys = [];
  // 'text' drops foreign signature material first so the unsigned flow below
  // never treats another provider's batch as a signed-protocol message.
  const stripped = mode === 'text' ? stripForeignSignedThinking(messages, mode) : messages;
  const normalized = normalizeSignedToolHistory(stripped).map(m => {
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
    if (block.signature && mode === 'signed') {
      const record = getRegistry().lookup(scope, block.thinking, block.signature, now);
      verifiedKeys.push(record.key);
      copy.signature = block.signature;
      copy.signatureType = record.type;
    }
    const next = { ...m, nativeThinkingBlocks: [copy] };
    // 'text' keeps the summary but drops the opaque signature for unsigned replay.
    if (mode !== 'signed') delete next.reasoning_signature;
    return next;
  });
  // Renew only after the entire history passes validation. Invalid batches cannot
  // extend retention for an otherwise valid prefix. Persist before dispatch.
  // `renew` is false on the second call of the same attempt (adapter → wire
  // builder): validation still runs, but the retention/alias writes already
  // happened once and each is a full-file sync rewrite.
  if (renew && verifiedKeys.length) getRegistry().touch(verifiedKeys, now);
  // The candidate scope was selected before account/session resolution. Learn
  // it ONLY after every history block has passed the original strict checks.
  if (renew && verifiedKeys.length && params.messagesIdentity) {
    messagesIdentityAliases().confirm(params.messagesIdentity, params.nativeThinkingScope, now);
    log.debug('Messages native identity verified', identityDiagnostic(params.messagesIdentity, params.nativeThinkingScope, 'history-verified', 'validated'));
  }
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
    if (finish.toolCalls?.length > 1) validateParallelCallIds(finish.toolCalls);
    const scope = origin(params);
    // Durably register before exposing the opaque signature to the client.
    getRegistry().issue(scope, thinking, signature, type, now());
    yield { type: 'signature', reasoning_signature: signature, signatureType: type };
  }
  for (const ev of pending) yield ev;
  yield finish;
}

export const __thinkingTesting = {
  clear() { registry = undefined; try { fs.unlinkSync(registryFile); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
  reload() { registry = undefined; },
  setCapacity(n) { getRegistry().maxRecords = n; },
  size: () => getRegistry().records.size, TTL_MS, MAX_RECORDS, MAX_BYTES, registryFile,
};
