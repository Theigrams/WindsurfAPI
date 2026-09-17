import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { resolveSessionId, commitAfterResponse, getSessionEnvForModel, _resetForTests,
  _getStoreSize, _getIndexStats, buildPairHashes, MAX_NATIVE_SESSION_STATES } from '../src/session-continuity.js';
const legacy = { DEVIN_CONNECT_SESSION_REUSE: '1', DEVIN_CONNECT_SESSION_MAX_STATES: '2' };
const native = getSessionEnvForModel('swe-2-high', { ...legacy,
  DEVIN_CONNECT_NATIVE_THINKING: '1', DEVIN_CONNECT_NATIVE_THINKING_SIGNED_MODELS: 'swe-2-high' });
const file = path.join(config.dataDir, 'native-thinking-sessions.json');
const input = label => [{ role: 'user', content: label }];
const pair = label => [...input(label), { role: 'assistant', content: 'answer-' + label }];
const disk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
beforeEach(() => { process.env.DEVIN_CONNECT_NATIVE_THINKING = '1'; _resetForTests(); });
afterEach(() => { _resetForTests(); delete process.env.DEVIN_CONNECT_NATIVE_THINKING; });
function seedFullNativePool() {
  resolveSessionId('seed', input('seed'), native);
  const saved = disk(), template = saved.states[0];
  saved.states = Array.from({ length: MAX_NATIVE_SESSION_STATES }, (_, i) => ({ ...template,
    stateId: 'fixture-state-' + i, sessionId: 'fixture-session-' + i, configId: 'fixture-config-' + i,
    scopeId: 'fixture-scope-' + i, rootKey: 'fixture-scope-' + i + ':root', lastSeen: Date.now() - 100000 + i }));
  fs.writeFileSync(file, JSON.stringify(saved));
  _resetForTests({ memoryOnly: true });
}
test('creating native sessions must not evict a full legacy pool', () => {
  const a = resolveSessionId('a', input('a'), legacy);
  const b = resolveSessionId('b', input('b'), legacy);
  resolveSessionId('native', input('native'), native);
  assert.equal(_getStoreSize(), 3);
  assert.equal(resolveSessionId('a', input('a'), legacy), a);
  assert.equal(resolveSessionId('b', input('b'), legacy), b);
});
test('creating legacy sessions must not evict a full native pool', () => {
  seedFullNativePool();
  resolveSessionId('legacy', input('legacy'), legacy);
  assert.equal(_getStoreSize(), MAX_NATIVE_SESSION_STATES + 1);
});
for (const route of ['resolve', 'commit-provisional', 'commit-existing', 'commit-overlap']) {
  test(`promotion through ${route} respects native capacity and survives reload`, () => {
    seedFullNativePool();
    const id = resolveSessionId('promote', input('promote'), legacy);
    if (route === 'commit-existing' || route === 'commit-overlap') commitAfterResponse('promote', pair('promote'), legacy);
    // Restore a full native pool even on the baseline, where legacy insertion
    // wrongly evicts one native entry. This isolates the promotion overflow.
    resolveSessionId('fill-native', input('fill-native'), native);
    let result;
    if (route === 'resolve') result = resolveSessionId('promote', input('promote'), native);
    else result = commitAfterResponse('promote', route === 'commit-overlap'
      ? [...pair('promote'), ...pair('next')] : pair('promote'), native);
    assert.equal(result, id, 'promotion preserves the already selected upstream session');
    const saved = disk();
    assert.equal(saved.states.length, MAX_NATIVE_SESSION_STATES);
    assert.ok(saved.states.some(s => s.sessionId === result));
    assert.ok(!saved.states.some(s => s.stateId === 'fixture-state-0'), 'LRU native entry is evicted');
    assert.equal(_getIndexStats().deadMemberships, 0);
    _resetForTests({ memoryOnly: true });
    assert.doesNotThrow(() => resolveSessionId('new', input('new'), legacy));
  });
}
test('failed native admission does not evict another live signed session', () => {
  seedFullNativePool();
  buildPairHashes('load', []);
  const before = fs.readFileSync(file);
  fs.renameSync(file, file + '.backup');
  fs.mkdirSync(file);
  try {
    assert.throws(() => resolveSessionId('failed-write', input('failed-write'), native), { code: 'NATIVE_THINKING_STORAGE_ERROR' });
    assert.equal(_getStoreSize(), MAX_NATIVE_SESSION_STATES + 1, 'all existing signed sessions survive the failed admission');
    assert.equal(_getIndexStats().deadMemberships, 0);
  } finally {
    fs.rmdirSync(file);
    fs.renameSync(file + '.backup', file);
  }
  assert.deepEqual(fs.readFileSync(file), before);
  const recovered = resolveSessionId('failed-write', input('failed-write'), native);
  assert.equal(disk().states.length, MAX_NATIVE_SESSION_STATES);
  assert.ok(disk().states.some(s => s.sessionId === recovered));
  _resetForTests({ memoryOnly: true });
  assert.doesNotThrow(() => buildPairHashes('reload', []));
});
