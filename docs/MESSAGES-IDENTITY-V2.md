# Messages native identity v2 (phase 1)

This change is **opt-in**, through `DEVIN_CONNECT_MESSAGES_IDENTITY_V2=1`.
It applies only to Messages requests routed to a native **signed** Devin
selector, when the server's caller is an API principal with the IP/UA fallback
and `metadata.user_id` has a usable identity. It does not change shared
`callerKeyFromRequest`, Chat/Responses/Gemini, dashboard callers, existing
generic body scopes, unsigned selectors or native-tool-bridge authorization.

## Problem and behavior

The old Messages handler appended the metadata tag AFTER the IP/UA fingerprint.
Switching an SDK from streaming to non-streaming changed that fingerprint,
splitting the same metadata identity into another caller/session and rejecting
its existing signatures. V2 uses a stable, API-principal-scoped metadata digest.
Structured metadata keeps account, device and session dimensions (including
camelCase aliases) instead of choosing device and discarding session. Plain
string IDs remain opaque client-declared scopes. IP and UA are absent from the
new scope. Metadata is **not authenticated user identity**; deployments sharing
a key across mutually untrusted users still need trusted gateway/user auth.

Blank, invalid, oversized, conflicting or object-valued identity fields do not
enable v2. Explicit generic scopes preserve their original precedence. Clients
without a conversation ID still use the existing content-based session matcher;
v2 does not invent a unique conversation ID from an opaque user ID.

## Legacy compatibility

New unsigned histories enter the stable scope. For signed histories, selection
considers ONLY the stable scope, the exact legacy scope derived from the current
request, and aliases previously verified for this stable identity. Registry
signature hashes are routing hints, not replay authorization. Ambiguous matches
are rejected; all existing summary/type/model/account/session/expiry checks run
before dispatch. Only a fully valid history records/renews a legacy alias.

The alias file is `DATA_DIR/messages-identity-aliases.json`. It contains only an
owner digest, hashed-component legacy scope and idle timestamp; no raw metadata,
UA/IP, prompts, signatures or tokens. It uses the existing atomic file writer,
30-day idle retention and a 10,000-entry fail-closed cap. Existing signature and
session files are not relabelled or migrated. This retains the current
single-writer, replica-local storage assumption.

An old conversation first resumed with a DIFFERENT UA, without a learned alias,
cannot be safely recovered from opaque hashes alone. Continue once from its
original client context with valid history to establish the association, or
start a new context. Do not copy aliases based only on a matching signature,
rewrite the registry, or disable provenance checks. Learning an alias preserves
the old scope's isolation semantics; it does not retroactively strengthen old
device-scoped conversations into uniquely identified branches.

Diagnostics report `version`, identity `source`, hashed scope, selection `reason`
and pre-resolution `sessionMatch` (`history`, `root`, `unmatched`, `disabled`).
`unmatched` is not proof a new session was created: the resolver may subsequently
use its compaction fallback. Successful full verification emits a debug event.
No raw identity or signature is included in these new diagnostics.

## Explicit remaining limitation: sibling branches

Offline handler tests confirm the existing content-window matcher can reject
this sequence in BOTH legacy and v2 identity modes:

1. Main answer completes.
2. A background memory-extraction turn successfully continues that history.
3. Main continues from the old main answer, omitting the background turn.

The background completion advances the shared matching window; the sibling
main request can get another upstream session and fail source verification.
The corresponding test asserts the current safe rejection, **not a fix**.
V2 fixes transport identity instability, not branch management or signature
portability. Do not enable it broadly for a branching client until phase 2
addresses this behavior. No upstream cross-session/model/account constraints
are relaxed or claimed as verified.

## Validation and rollback

`test/messages-native-identity.test.js` uses synthetic signatures and replaces
the upstream stream generator. It covers real Messages→Chat→native conversion,
stream/generate transitions, legacy migration, three-process restart, distinct
principals/sessions, invalid origins, ambiguous routing, expiry, storage errors,
diagnostic privacy and the known sibling-branch limitation. Existing native
thinking, persistence, Messages, caller and continuity regressions must pass.
These are offline protocol checks, not proof of upstream acceptance.

Before a future rollout, retain code/config and all native state files as a
coherent snapshot and enable only selected compatible traffic. Setting the flag
to `0` restores old identity selection. Migrated legacy conversations retain
their old registry/session identities; newly created v2 conversations cannot
automatically replay under old code or with the flag disabled. Preserve their
state and serve them with v2 or establish new contexts explicitly. Never delete
state or restore a stale snapshot while silently discarding intervening writes.

Phase 1 does not deploy or restart the service, change production configuration,
send model requests, or change effort routing, signed-model allowlists, account
rotation rules, multi-block support or storage transaction semantics.
