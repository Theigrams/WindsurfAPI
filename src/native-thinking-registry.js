import { createHash } from 'node:crypto';
import { readNativeState, writeNativeState, nativeStorageError, NATIVE_RETENTION_MS } from './native-thinking-storage.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const MAX_NATIVE_RECORDS = 50000;

export function nativeOrigin(params) {
  return { caller: hash(params.nativeThinkingScope), model: params.model, account: hash(params.token), session: params.sessionId };
}
function identity(origin, thinking, signature) {
  return { ...origin, thinking: hash(thinking), signature: hash(signature) };
}
function incompatible(reason, detail) {
  return Object.assign(new Error(`Native thinking: ${detail} [${reason}].`), {
    code: 'NATIVE_THINKING_INCOMPATIBLE', status: 400, reason,
  });
}

export class NativeThinkingRegistry {
  constructor(file, { retentionMs = NATIVE_RETENTION_MS, maxRecords = MAX_NATIVE_RECORDS } = {}) {
    this.file = file;
    this.retentionMs = retentionMs;
    this.maxRecords = maxRecords;
    const saved = readNativeState(file);
    if (saved && !Array.isArray(saved.entries)) throw nativeStorageError('invalid signature metadata');
    const entries = saved?.entries || [];
    if (!Array.isArray(entries) || entries.length > MAX_NATIVE_RECORDS || entries.some(r =>
      !r || !['caller', 'account', 'thinking', 'signature'].every(k => isHash(r[k])) ||
      !['model', 'session', 'type'].every(k => typeof r[k] === 'string' && r[k].length > 0 && r[k].length < 1024) ||
      !Number.isFinite(r.lastUsed))) throw nativeStorageError('invalid signature metadata');
    this.records = new Map(entries.map(r => [digest(this.ident(r)), r]));
  }
  ident(r) { return Object.fromEntries(['caller', 'model', 'account', 'session', 'thinking', 'signature'].map(k => [k, r[k]])); }
  save(next) {
    writeNativeState(this.file, { entries: [...next.values()] });
    this.records = next;
  }
  lookup(origin, thinking, signature, now) {
    const id = identity(origin, thinking, signature), key = digest(id);
    const record = this.records.get(key);
    if (record) {
      if (now - record.lastUsed >= this.retentionMs) throw incompatible('SIGNATURE_EXPIRED', 'signature registration expired after an idle retention period');
      return { key, type: record.type };
    }
    // Diagnostic only: a near match NEVER authorizes replay under another origin.
    const candidates = [...this.records.values()].filter(r => r.signature === id.signature);
    if (candidates.length) {
      const matchingOrigin = candidates.find(r => ['caller', 'model', 'account', 'session'].every(k => r[k] === id[k]));
      if (matchingOrigin) throw incompatible('THINKING_MISMATCH', 'thinking summary differs from the registered signature');
      const differences = candidates.map(r => ['caller', 'model', 'account', 'session'].filter(k => r[k] !== id[k]))
        .sort((a, b) => a.length - b.length)[0];
      throw incompatible('SIGNATURE_ORIGIN_MISMATCH', `signature origin differs in ${differences.join('/')}`);
    }
    throw incompatible('SIGNATURE_UNKNOWN', 'signature registration is unknown (not recorded here or removed before persistence was enabled)');
  }
  touch(keys, now) {
    if (!keys.length) return;
    const next = new Map(this.records);
    for (const key of keys) next.set(key, { ...next.get(key), lastUsed: Math.max(now, next.get(key).lastUsed) });
    this.save(next);
  }
  issue(origin, thinking, signature, type, now) {
    const id = identity(origin, thinking, signature), key = digest(id);
    const old = this.records.get(key);
    if (old && old.type !== type) throw incompatible('SIGNATURE_TYPE_MISMATCH', 'signature type changed for an existing block');
    const next = new Map([...this.records].filter(([, r]) => now - r.lastUsed < this.retentionMs));
    // Do not silently evict still-live signatures when a long conversation grows.
    if (!next.has(key) && next.size >= this.maxRecords) throw nativeStorageError('signature metadata capacity reached');
    next.set(key, { ...id, type, lastUsed: now });
    this.save(next);
  }
}
