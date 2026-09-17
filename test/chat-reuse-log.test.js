// The DEVIN_CONNECT session-reuse log line must identify WHICH account served
// the resumed session (acct=<account id>), not just the session_id. This locks
// the log-line construction itself: the acct= tag lives in the same template
// literal as session_id=, and ccAcct is in scope at the call site (it is read
// immediately below to set connectParams.token).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT = readFileSync(join(__dirname, '..', 'src', 'handlers', 'chat.js'), 'utf8');

const REUSE_LOG = 'DEVIN_CONNECT session reuse active';

describe('chat handler: DEVIN_CONNECT reuse log carries the account', () => {
  it('the reuse log line appends acct= to the session_id interpolation', () => {
    const idx = CHAT.indexOf(REUSE_LOG);
    assert.ok(idx !== -1, 'the DEVIN_CONNECT reuse log line must exist');
    const line = CHAT.slice(idx, CHAT.indexOf('\n', idx));
    assert.match(line, /session_id=\$\{connectSessionId\}/, 'the log must carry session_id');
    assert.match(
      line,
      /acct=\$\{ccAcct\?\.account\?\.id \|\| 'env-token'\}/,
      'the log must append acct=<account id> (env-token fallback when no account is bound)',
    );
  });

  it('ccAcct is in scope at the reuse log call site (read right below for connectParams.token)', () => {
    const idx = CHAT.indexOf(REUSE_LOG);
    assert.ok(idx !== -1, 'the DEVIN_CONNECT reuse log line must exist');
    const tokenIdx = CHAT.indexOf('connectParams.token = ccAcct.apiKey;', idx);
    assert.ok(tokenIdx !== -1, 'connectParams.token must still be assigned from ccAcct after the reuse log');
    const between = CHAT.slice(idx, tokenIdx);
    const guardIdx = between.lastIndexOf('if (ccAcct) {');
    assert.ok(guardIdx !== -1, 'an if (ccAcct) guard must wrap the token assignment');
    assert.ok(!between.slice(guardIdx).includes('//'), 'no comment may sit between the guard and the assignment');
    assert.ok(tokenIdx - idx < 800, 'the ccAcct token read must stay adjacent to the reuse log call site');
  });
});
