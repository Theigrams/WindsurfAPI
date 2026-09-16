// Who gets blamed for a failed DEVIN_CONNECT request.
//
// finalizeConnectAccount's job is to separate "this ACCOUNT is bad" from "this
// REQUEST was bad". Getting it wrong in the second direction is expensive: a
// caller looping on a request the upstream always rejects walks the whole pool
// offline, three errors at a time, and the status flip is persisted to
// accounts.json so a restart does not undo it.
//
// That exact bug was fixed once for CONTENT_BLOCKED (upstream rejected the prompt)
// and MODEL_BLOCKED (tier wall). UPSTREAM_ERROR was missed: it carries the gRPC
// `internal` class, which classifyUpstreamError itself documents as "PERMANENT
// client mistakes (short fingerprint, gzipped request body) — fails identically
// every retry". The session token is alive and the account is healthy, yet it fell
// through to the generic reportError and got evicted.
//
// The eviction only shows up when a healthy peer exists — a single-account pool is
// covered by the last-account exemption, which is why this went unnoticed.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addAccountByKey, removeAccount, getAccountInternal,
} from '../src/auth.js';
import { finalizeConnectAccount } from '../src/handlers/chat.js';

const created = [];
function seed(label) {
  const a = addAccountByKey(`devin-session-token$blame-${label}-${Math.random().toString(36).slice(2)}`, label);
  created.push(a.id);
  return getAccountInternal(a.id);
}
function fail(acct, code, times = 3) {
  for (let i = 0; i < times; i++) {
    const err = Object.assign(new Error(`simulated ${code}`), { code });
    finalizeConnectAccount(
      { id: acct.id, apiKey: acct.apiKey },
      { model: 'swe-1-6-slow', selector: 'swe-1-6-slow', startTime: Date.now(), err },
    );
  }
  return getAccountInternal(acct.id);
}

beforeEach(() => { created.length = 0; });
afterEach(() => { while (created.length) removeAccount(created.pop()); });

describe('request-side failures never evict the account', () => {
  for (const code of ['NATIVE_THINKING_INCOMPATIBLE', 'NATIVE_THINKING_STORAGE_ERROR']) {
    it(`${code} does not charge account errors or the internal-error circuit breaker`, () => {
      const acct = seed('local-provenance'); seed('healthy-peer');
      const after = fail(acct, code);
      assert.equal(after.errorCount || 0, 0);
      assert.equal(after.internalErrorStreak || 0, 0);
    });
  }
  // A healthy peer must exist, otherwise the last-account exemption masks the
  // eviction and the test would pass for the wrong reason.
  // STREAM_TRUNCATED joined this list when the truncation detection shipped: the
  // socket ending mid-answer with no end-of-stream frame is a TRANSPORT fault
  // (ECONNRESET class), not an account fault. Without an explicit branch it fell
  // through to the generic reportError — so a flaky network path to the upstream
  // would evict healthy accounts three truncations at a time, reproducing the exact
  // bug the CONTENT_BLOCKED / UPSTREAM_ERROR exemptions above were added to remove.
  // TIMEOUT / DEADLINE_EXCEEDED / NO_TOKEN joined next, found by asking the obvious
  // follow-up question: STREAM_TRUNCATED landed in the silent fallthrough by
  // accident, so WHICH OTHER codes are down there? Measured, all three evicted a
  // healthy account in 3 calls. TIMEOUT and DEADLINE_EXCEEDED are upstream stalls
  // (devin-connect.js says so in its own comments); NO_TOKEN is a CONFIGURATION
  // fault, so charging account health for it is doubly wrong.
  const REQUEST_SIDE = ['UPSTREAM_ERROR', 'CONTENT_BLOCKED', 'MODEL_BLOCKED', 'STREAM_TRUNCATED',
    'TIMEOUT', 'DEADLINE_EXCEEDED', 'NO_TOKEN'];

  for (const code of REQUEST_SIDE) {
    it(`${code} x3 keeps the account in rotation (fault is in the request)`, () => {
      const victim = seed(`v-${code}`);
      seed(`peer-${code}`); // voids the last-account exemption
      const after = fail(victim, code);
      assert.notEqual(after.status, 'error',
        `${code} evicted a healthy account — a caller looping on a bad request would `
        + 'walk the whole pool offline three errors at a time');
      assert.notEqual(after.errorCount, 3,
        `${code} must not accumulate the eviction counter`);
    });
  }

  it('a client looping on malformed requests cannot drain the pool', () => {
    const accounts = [seed('p1'), seed('p2'), seed('p3')];
    for (const a of accounts) fail(a, 'UPSTREAM_ERROR', 6);
    const alive = accounts.filter(a => getAccountInternal(a.id).status !== 'error');
    assert.equal(alive.length, accounts.length,
      'every account must survive — the requests were malformed, not the accounts');
  });
});

describe('account-side failures still count against the account', () => {
  it('an unclassified account fault still evicts after the streak', () => {
    // Guard against over-correcting: a genuine account error must still be able
    // to remove a key from rotation.
    const victim = seed('genuine');
    seed('peer-genuine');
    const after = fail(victim, 'SOME_UNKNOWN_ACCOUNT_FAULT');
    assert.equal(after.status, 'error',
      'a genuinely faulty account must still be evicted after the error streak');
  });
});

// ─── 结构守卫 ───────────────────────────────────────────────
//
// The bug above happened TWICE for the same structural reason: the classification
// ends in a bare `else reportError(apiKey)`, so any error code nobody thought about
// is silently treated as an account fault and evicts healthy accounts. First
// STREAM_TRUNCATED landed there, then TIMEOUT / DEADLINE_EXCEEDED / NO_TOKEN.
//
// A behavioural test cannot catch the NEXT one — the code that will land there
// hasn't been written yet. So this guard reads both sources and fails when
// devin-connect.js can emit a code that finalizeConnectAccount does not classify.
describe('structural guard — every upstream code has an explicit blame decision', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

  // Collect every code that can REACH finalizeConnectAccount, from both sources:
  //
  //  (a) codes devin-connect.js constructs itself — UPPER_SNAKE, `code: 'X'`;
  //  (b) codes it never constructs but happily propagates — Node's socket codes
  //      and the lowercase gRPC statuses. These arrive with `.code` already set
  //      and travel through the connect generator untouched.
  //
  // (b) is why the first version of this guard was blind to the largest class of
  // codes that actually reached the fallthrough: it read only `code: 'X'` literals
  // with an [A-Z_] character class, so ECONNRESET / ETIMEDOUT / EPIPE /
  // ECONNREFUSED were invisible AND a lowercase status like `unavailable` could
  // not match at all. Measured, healthy peer seeded: three of each flipped the
  // account to status='error'. The guard reported emitted.size = 12 and passed.
  //
  // devin-connect.js's own RETRYABLE_CODES list is the authoritative enumeration of
  // (b): it exists precisely because the transport layer already decided these are
  // retryable transport conditions, which is incompatible with blaming the account.
  // The gRPC statuses classifyUpstreamError PASSES THROUGH verbatim.
  //
  // Its last line is `code: code || 'UPSTREAM_ERROR'`, so any status the named
  // branches above did not claim exits with its original lowercase spelling and no
  // literal anywhere names it. That is a THIRD blind spot, one layer below the two
  // this guard already closed: enumerating `code: 'X'` literals plus RETRYABLE_CODES
  // still could not see `aborted` / `cancelled` / `deadline_exceeded`, and measured,
  // three of each flipped a healthy account to status='error'.
  //
  // The character class covers digits and hyphens too: this file's own history is a
  // sequence of vocabularies that could not SEE a family (UPPER_SNAKE only, then
  // lowercase, now digits/hyphens), and an upstream is free to introduce
  // `ERR_HTTP2_STREAM_ERROR` or `http2-goaway` at any time.
  //
  // These cannot be derived from the source — the passthrough is by construction
  // open-ended — so the canonical gRPC status set is listed here, and a separate
  // assertion below pins that the passthrough still exists so this list stays
  // load-bearing rather than quietly becoming decorative.
  const GRPC_STATUSES = [
    'cancelled', 'unknown', 'invalid_argument', 'deadline_exceeded', 'not_found',
    'already_exists', 'permission_denied', 'resource_exhausted', 'failed_precondition',
    'aborted', 'out_of_range', 'unimplemented', 'internal', 'unavailable', 'data_loss',
    'unauthenticated',
  ];

  function codesReachingBlame(connectSrc) {
    const constructed = [...connectSrc.matchAll(/code:\s*'([A-Za-z0-9_-]+)'/g)].map(m => m[1]);
    const retryable = (connectSrc.match(/const RETRYABLE_CODES = new Set\(\[([^\]]*)\]/) || [, ''])[1];
    const propagated = [...retryable.matchAll(/'([A-Za-z0-9_-]+)'/g)].map(m => m[1]);
    // A passthrough status only reaches blame if no named branch claims it first.
    const claimedByName = new Set(
      [...connectSrc.matchAll(/code === '([a-z_]+)'/g)].map(m => m[1]),
    );
    const passthrough = GRPC_STATUSES.filter((s) => !claimedByName.has(s));
    return new Set([...constructed, ...propagated, ...passthrough]);
  }

  it('no code reaches the silent `else reportError` fallthrough unclassified', () => {
    const connectSrc = read('../src/devin-connect.js');
    const chatSrc = read('../src/handlers/chat.js');

    const emitted = codesReachingBlame(connectSrc);
    assert.ok(emitted.size >= 10, `expected the real code vocabulary, got ${emitted.size}`);
    // Meta-check on the collector itself: a vocabulary that silently loses a whole
    // family is how this guard passed the defect twice. Pin all three families.
    for (const c of [
      'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED',   // Node socket codes
      'aborted', 'cancelled', 'deadline_exceeded',            // passed-through gRPC statuses
      'UPSTREAM_ERROR', 'RATE_LIMITED',                      // constructed literals
    ]) {
      assert.ok(emitted.has(c),
        `the code vocabulary must include ${c} — it reaches finalizeConnectAccount with .code `
        + 'set and a guard that cannot see it cannot protect against it');
    }

    // ...and pin that the passthrough it models still exists. If classifyUpstreamError
    // ever stops returning the raw code, the GRPC_STATUSES list becomes decorative and
    // this assertion says so instead of letting it rot silently.
    assert.match(
      connectSrc, /return \{ code: code \|\| 'UPSTREAM_ERROR'/,
      'classifyUpstreamError is expected to pass an unrecognised code through verbatim; if that '
      + 'changed, the passed-through gRPC status list in this guard needs revisiting',
    );

    // Everything finalizeConnectAccount decides explicitly: either an `err.code ===`
    // arm, or a member of the TRANSPORT_FAULT_CODES set. Read from the set
    // declaration through the end of the function — the `err.code ===` arms live
    // INSIDE finalizeConnectAccount, which follows the declaration.
    const from = chatSrc.indexOf('const TRANSPORT_FAULT_CODES');
    assert.notEqual(from, -1, 'TRANSPORT_FAULT_CODES declaration not found');
    const end = chatSrc.indexOf('\n}', chatSrc.indexOf('releaseAccountById(acct.id)', from));
    const body = chatSrc.slice(from, end > from ? end : undefined);
    // Same character class on both sides, or a lowercase code would look
    // "unclassified" even after being handled.
    const classified = new Set([
      ...[...body.matchAll(/err\.code === '([A-Za-z0-9_-]+)'/g)].map(m => m[1]),
      ...[...(body.match(/const TRANSPORT_FAULT_CODES = new Set\(\[([^\]]*)\]/) || [, ''])[1]
        .matchAll(/'([A-Za-z0-9_-]+)'/g)].map(m => m[1]),
    ]);

    const unclassified = [...emitted].filter(c => !classified.has(c));
    assert.deepEqual(unclassified, [],
      'these codes fall through to `else reportError`, which charges the account error '
      + 'budget and evicts healthy accounts after errorStreakThreshold hits. Decide '
      + 'explicitly: a real account fault stays in the fallthrough, anything else '
      + 'belongs in TRANSPORT_FAULT_CODES or its own arm. '
      + `Unclassified: ${unclassified.join(', ')}`);
  });

  // Behavioural half. The structural check above proves a decision was WRITTEN;
  // this proves the decision has the effect it claims. Both are needed: the
  // structural one catches the next unclassified code (behaviour cannot, the code
  // does not exist yet), and this one catches a classification that is present but
  // wired to the wrong outcome.
  it('a transport fault does not evict a healthy account, but an auth fault does', async () => {
    const { addAccountByKey, removeAccount, setAccountTier, getAccountInternal } =
      await import('../src/auth.js');
    const { getBreakerTunable } = await import('../src/runtime-config.js');
    const { finalizeConnectAccount } = await import('../src/handlers/chat.js');

    const made = [];
    const seed = (label) => {
      const a = addAccountByKey(
        `devin-session-token$blame-${label}-${Math.random().toString(36).slice(2)}`, label,
      );
      made.push(a.id);
      setAccountTier(a.id, 'pro');
      return a;
    };
    const hammer = (acct, code, times = 4) => {
      for (let i = 0; i < times; i++) {
        finalizeConnectAccount(
          { id: acct.id, apiKey: acct.apiKey },
          {
            model: 'gpt-5.5', selector: 'gpt-5-5-low', startTime: Date.now() - 5,
            err: Object.assign(new Error(`synthetic ${code}`), { code }),
          },
        );
      }
      const fresh = getAccountInternal(acct.id);
      return {
        status: fresh.status,
        errorCount: fresh.errorCount || 0,
        // A classification can be "present but wired to the wrong outcome" in more
        // ways than an eviction: swapping the exemption for a long account-wide
        // cooldown leaves status and errorCount untouched while still benching the
        // account. Measure every dimension the arm could write.
        cooldownMs: fresh.rateLimitedUntil ? fresh.rateLimitedUntil - Date.now() : 0,
        quotaResetMs: fresh.quotaResetAt ? fresh.quotaResetAt - Date.now() : 0,
        modelCooldowns: Object.keys(fresh._modelRateLimits || {}).length,
      };
    };

    try {
      // A peer must exist or lastAccountExempt masks the eviction entirely — the
      // reason this failure mode kept hiding on single-account pools.
      seed('peer');
      for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'unavailable', 'TIMEOUT']) {
        const victim = seed(`t-${code}`);
        const after = hammer(victim, code);
        assert.equal(after.status, 'active',
          `${code} is a transport fault and must not evict the account (status became ${after.status})`);
        assert.equal(after.errorCount, 0,
          `${code} must not charge the error budget (got ${after.errorCount})`);
        // A transport fault DOES record a health event, and reportInternalError
        // quarantines after a consecutive streak — that is the documented other half
        // of the exemption ("a genuinely sick account is still de-prioritized by
        // selection"). So the bar is not "no cooldown at all", it is "nothing longer
        // than that bounded, self-healing quarantine": swapping the exemption for a
        // rate-limit-length window would leave status and errorCount untouched while
        // still benching the account for hours, and the original two-field assertion
        // could not see that.
        const quarantineCeiling = getBreakerTunable('internalQuarantineMs') + 5_000;
        assert.ok(
          after.cooldownMs <= quarantineCeiling,
          `${code} wrote a ${after.cooldownMs}ms account-wide cooldown, beyond the bounded `
          + `internal-error quarantine (${quarantineCeiling}ms). A transport fault must not bench `
          + 'the account for longer than that self-healing window.',
        );
        assert.equal(after.quotaResetMs, 0, `${code} must not write a quota cooldown`);
        assert.equal(after.modelCooldowns, 0, `${code} must not write a model/selector cooldown`);
      }

      const authVictim = seed('auth');
      const after = hammer(authVictim, 'UNAUTHORIZED', 3);
      assert.ok(after.errorCount >= 3,
        'a genuine auth fault MUST still charge the error budget — the exemption must not be '
        + 'so broad that real account failures stop counting');
    } finally {
      while (made.length) removeAccount(made.pop());
    }
  });
});
