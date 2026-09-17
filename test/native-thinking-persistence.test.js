import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NativeThinkingRegistry, nativeOrigin } from '../src/native-thinking-registry.js';
import { NATIVE_RETENTION_MS } from '../src/native-thinking-storage.js';

const dirs = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-provenance-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const origin = nativeOrigin({ nativeThinkingScope: 'caller-fixture', token: 'token-fixture', model: 'swe-2-high', sessionId: 'session-fixture' });

it('renews an actively replayed signature beyond its original deadline and reloads the renewal', () => {
  const file = path.join(temp(), 'records.json');
  const store = new NativeThinkingRegistry(file, { retentionMs: 30 * 60000 });
  store.issue(origin, 'summary-fixture', 'signature-fixture', 'sealed', 0);
  for (const minute of [1, 10, 20, 29, 40, 59, 80]) {
    const record = store.lookup(origin, 'summary-fixture', 'signature-fixture', minute * 60000);
    store.touch([record.key], minute * 60000);
  }
  const loaded = new NativeThinkingRegistry(file, { retentionMs: 30 * 60000 });
  assert.equal(loaded.lookup(origin, 'summary-fixture', 'signature-fixture', 100 * 60000).type, 'sealed');
  assert.throws(() => loaded.lookup(origin, 'summary-fixture', 'signature-fixture', 110 * 60000), /SIGNATURE_EXPIRED/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const disk = fs.readFileSync(file, 'utf8');
  for (const secret of ['summary-fixture', 'signature-fixture', 'token-fixture', 'caller-fixture']) assert.equal(disk.includes(secret), false);
});

it('retains inactive desktop conversations for 30 days instead of 30 minutes', () => {
  const store = new NativeThinkingRegistry(path.join(temp(), 'records.json'));
  store.issue(origin, 'summary', 'signature', 'sealed', 0);
  assert.doesNotThrow(() => store.lookup(origin, 'summary', 'signature', 24 * 60 * 60000));
  assert.throws(() => store.lookup(origin, 'summary', 'signature', NATIVE_RETENTION_MS), /SIGNATURE_EXPIRED/);
});

it('distinguishes altered summary, unknown signature and each wrong origin after reload', () => {
  const file = path.join(temp(), 'records.json');
  new NativeThinkingRegistry(file).issue(origin, 'summary', 'signature', 'sealed', 0);
  const store = new NativeThinkingRegistry(file);
  for (const key of ['caller', 'model', 'account', 'session']) {
    assert.throws(() => store.lookup({ ...origin, [key]: 'different' }, 'summary', 'signature', 1), /SIGNATURE_ORIGIN_MISMATCH/);
  }
  assert.throws(() => store.lookup(origin, 'changed', 'signature', 1), /THINKING_MISMATCH/);
  assert.throws(() => store.lookup(origin, 'summary', 'unknown', 1), /SIGNATURE_UNKNOWN/);
});

it('retains more than 500 signed turns without evicting the earliest one', () => {
  const file = path.join(temp(), 'records.json');
  const store = new NativeThinkingRegistry(file);
  for (let i = 0; i < 501; i++) store.issue(origin, '', `signature-${i}`, 'sealed', i);
  assert.equal(new NativeThinkingRegistry(file).lookup(origin, '', 'signature-0', 502).type, 'sealed');
});

it('fails closed on corrupt metadata or a failed atomic write and keeps the old durable state', () => {
  const dir = temp(), file = path.join(dir, 'records.json');
  const store = new NativeThinkingRegistry(file);
  store.issue(origin, 'summary', 'signature', 'sealed', 0);
  const original = fs.readFileSync(file, 'utf8');
  store.file = dir;
  assert.throws(() => store.issue(origin, 'summary', 'new-signature', 'sealed', 1), /cannot save metadata/);
  assert.equal(store.records.size, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.writeFileSync(file, '{');
  assert.throws(() => new NativeThinkingRegistry(file), /cannot read saved metadata/);
});

it('preserves session, ModelConfig and opaque replay bytes across two separate processes', () => {
  const dir = temp();
  const env = { ...process.env, DATA_DIR: dir, WINDSURFAPI_SKIP_DOTENV: '1', DEVIN_CONNECT_NATIVE_THINKING: '1',
    DEVIN_CONNECT_NATIVE_THINKING_SIGNED_MODELS: 'swe-2-high', DEVIN_CONNECT_SESSION_REUSE: '1', DEVIN_CONNECT_MODEL_CONFIG_STABLE: '1' };
  const worker = new URL('./fixtures/native-thinking-restart-worker.mjs', import.meta.url);
  const first = JSON.parse(execFileSync(process.execPath, [worker.pathname, 'issue'], { env, encoding: 'utf8' }));
  const second = JSON.parse(execFileSync(process.execPath, [worker.pathname, 'replay'], { env, encoding: 'utf8' }));
  assert.equal(second.session, first.session);
  assert.equal(second.config.configId, first.config.configId);
  assert.equal(second.config.turn, 2);
  assert.equal(second.summary, 'summary-fixture');
  assert.equal(second.signature, 'opaque-fixture');
  for (const file of ['native-thinking-sessions.json', 'native-thinking-signatures.json']) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const privateText of ['private-opener-fixture', 'private-answer-fixture', 'opaque-fixture', 'summary-fixture', 'token-fixture']) assert.equal(text.includes(privateText), false);
  }
});
