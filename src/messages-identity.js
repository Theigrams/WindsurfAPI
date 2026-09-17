// Messages-only native replay identity. Metadata is a client-declared scope
// within the authenticated API principal, NOT a replacement for authentication.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { readNativeState, writeNativeState, nativeStorageError, NATIVE_RETENTION_MS } from './native-thinking-storage.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const signal = value => typeof value === 'string' && value.trim().length <= 4096 ? value.trim() : '';

// Preserve the old byte-level derivation exclusively for legacy validation.
export function extractCallerSubKey(body) {
  const userId = body?.metadata?.user_id;
  if (typeof userId !== 'string' || !userId) return '';
  let parsed = null;
  try { parsed = JSON.parse(userId); } catch {}
  const tag = parsed && typeof parsed === 'object'
    ? parsed.device_id || parsed.deviceId || parsed.session_id || parsed.sessionId || parsed.account_uuid || parsed.accountUuid || ''
    : userId;
  return tag ? hash(String(tag)).slice(0, 16) : '';
}

function metadataIdentity(body) {
  const raw = signal(body?.metadata?.user_id);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    return { source: 'metadata-user', value: ['opaque', raw] };
  }
  // Do not turn JSON scalars, arrays, object-valued IDs or conflicting aliases
  // into a shared "[object Object]" identity. Leave those on the legacy path.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const values = [];
  for (const [snake, camel] of [['account_uuid', 'accountUuid'], ['device_id', 'deviceId'], ['session_id', 'sessionId']]) {
    const a = signal(parsed[snake]), b = signal(parsed[camel]);
    if ((parsed[snake] != null && typeof parsed[snake] !== 'string') ||
        (parsed[camel] != null && typeof parsed[camel] !== 'string') || (a && b && a !== b)) return null;
    values.push(a || b);
  }
  if (!values.some(Boolean)) return null;
  return { source: values[2] ? 'metadata-session' : 'metadata-user', value: ['structured', ...values] };
}

export function messagesIdentity(body, callerKey, env = process.env) {
  if (env.DEVIN_CONNECT_MESSAGES_IDENTITY_V2 !== '1') return null;
  // Only replace the API+transport fallback. Explicit generic user/session
  // scopes and dashboard/anonymous callers keep their existing semantics.
  const principal = /^(api:[0-9a-f]{32})(?::client:[0-9a-f]{16})?$/.exec(callerKey || '')?.[1];
  const meta = metadataIdentity(body);
  if (!principal || !meta) return null;
  const legacySubkey = extractCallerSubKey(body);
  if (!legacySubkey) return null;
  return Object.freeze({
    stableScope: `${principal}:user:${hash(JSON.stringify(meta.value))}:messages-v2`,
    legacyScope: `${callerKey}:user:${legacySubkey}`,
    source: meta.source,
  });
}

// Only a fully verified legacy replay can add an alias. We keep the legacy
// caller/session/registry intact rather than relabelling existing signatures.
// No raw user IDs, UA, IP, prompts or signatures are persisted.
export class MessagesIdentityAliases {
  constructor(file, { maxRecords = 10000 } = {}) {
    this.file = file;
    this.maxRecords = maxRecords;
    const saved = readNativeState(file);
    if (saved && !Array.isArray(saved.entries)) throw nativeStorageError('invalid messages identity aliases');
    const rows = saved?.entries || [];
    if (!Array.isArray(rows) || rows.length > 10000 || rows.some(r => !r || typeof r.owner !== 'string' || typeof r.scope !== 'string' ||
      !/^[0-9a-f]{64}$/.test(r.owner) ||
      !/^api:[0-9a-f]{32}(?::client:[0-9a-f]{16})?:user:[0-9a-f]{16}$/.test(r.scope) ||
      !Number.isFinite(r.lastUsed))) throw nativeStorageError('invalid messages identity aliases');
    this.rows = rows;
  }
  candidates(identity, now = Date.now()) {
    const owner = hash(identity.stableScope);
    return this.rows.filter(r => r.owner === owner && now - r.lastUsed < NATIVE_RETENTION_MS).map(r => r.scope);
  }
  confirm(identity, scope, now = Date.now()) {
    if (scope === identity.stableScope) return;
    const owner = hash(identity.stableScope);
    const authorized = scope === identity.legacyScope || this.candidates(identity, now).includes(scope);
    if (!authorized) throw nativeStorageError('unverified messages identity alias');
    const next = this.rows.filter(r => now - r.lastUsed < NATIVE_RETENTION_MS && !(r.owner === owner && r.scope === scope));
    if (next.length >= this.maxRecords) throw nativeStorageError('messages identity alias capacity reached');
    next.push({ owner, scope, lastUsed: now });
    writeNativeState(this.file, { entries: next });
    this.rows = next;
  }
}

let aliases;
export function messagesIdentityAliases() {
  return aliases ||= new MessagesIdentityAliases(path.join(config.dataDir, 'messages-identity-aliases.json'));
}

export function identityDiagnostic(identity, scope, reason, sessionMatch) {
  return { version: 2, source: identity.source, scope: hash(scope).slice(0, 16), reason, sessionMatch };
}
