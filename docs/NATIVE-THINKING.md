# Native Devin thinking replay (experimental)

This feature preserves assistant thinking in Devin ChatMessage field 11,
opaque upstream signatures in field 12, and their string type in field 18.
Response fields are 9 (thinking), 10 (signature bytes) and 21 (type string).
It does not generate signatures, decrypt them, or insert reasoning into prompts.

## Configuration

All three settings are opt-in. The defaults leave existing traffic unchanged:

```dotenv
DEVIN_CONNECT_NATIVE_THINKING=0
DEVIN_CONNECT_NATIVE_THINKING_TEXT_MODELS=
DEVIN_CONNECT_NATIVE_THINKING_SIGNED_MODELS=
```

The lists use exact **resolved upstream selectors**, not client aliases. For
example, `glm-5.2` normally resolves to `glm-5-2`. Check routing evidence before
selecting models. An empty list enables nothing. A selector on both lists uses
the signed policy. Do not treat the list as a claim that a provider supports
replay; acceptance must be tested separately for each selector.

Unlisted models with unsigned history keep their legacy conversion behavior.
Signed history sent to an unlisted selector is rejected to prevent accidental
cross-model replay.

Signed mode requires an explicit caller scope, account token, stable session,
and native structured tools when tools are used. For the HTTP route this means
`DEVIN_CONNECT_SESSION_REUSE=1`, the selector included in any configured
`DEVIN_CONNECT_SESSION_MODELS` allowlist, and `experimental.nativeToolCall=true`.
Keep the existing ModelConfig/cache settings. Native mode does not add
`DEVIN_CONNECT_SESSION_REASONING_INJECT` checkpoints. The legacy
`DEVIN_CONNECT_REPLAY_REASONING` probe is independent and unnecessary here.

## Guarantees and limits

- Plain text, single tools and parallel tools per signed assistant are supported.
  A signed assistant remains one native message: its repeated field 6 contains
  all tool calls, while fields 11/12/18 contain the summary/signature/type once.
  Adjacent results are matched by tool-call ID and ordered by the original calls;
  the assistant and signature are never split or copied across those results.
  Parallel calls require unique nonempty IDs and one result for each ID before
  the next conversation turn. Missing, duplicate or unknown results are rejected
  before orphan stripping. Result text and images are preserved.
  Unsigned parallel calls retain the existing call/result pairing, with thinking
  on the first call only. Thinking text is not trimmed or promoted into content.
- In native thinking mode session lookup and response commits use client turn
  boundaries, before transport-specific tool splitting. A signed parallel turn
  followed by an unsigned parallel turn must retain the same session/ModelConfig;
  splitting the latter for the wire must not invalidate earlier signatures.
  For relays that include system/developer messages inside Anthropic history,
  the adapter retains original-role provenance for session matching. Updating a
  system reminder therefore does not count as editing a prior user turn. This
  internal annotation is not serialized and does not change wire conversion.
- Multiple thinking blocks, redacted thinking, and
  reasoning that resumes after content are rejected. No unverified mapping is
  silently used. Signed mode also rejects local stop-sequence truncation.
- Signed streams emit thinking immediately but hold later content until the
  complete upstream signature arrives. A signature delta is sent before closing
  its thinking block. This can delay the first content/tool event. A response
  that truly has no signature stays unsigned.
- Thinking, signatures, content, and terminal tool calls share a 2 MiB response
  limit. Each replayed thinking/signature pair also has a 2 MiB limit. Aborted,
  truncated, overflowing, or inconsistent responses do not create replay records.
- The in-memory provenance table stores hashes and upstream types, not thinking,
  signatures or tokens. It has 500 entries and a 30-minute lifetime. A signed
  replay must match the exact thinking, signature, caller, selector, token and
  session that produced it. Token rotation is conservatively a new account scope.
- Unknown/imported, expired, evicted or restart-lost signatures fail with
  `NATIVE_THINKING_INCOMPATIBLE`. Client-provided signature types are not trusted.
  No cross-model/session/account fallback is attempted for signed history.
- The table associates provenance; it does not cryptographically validate the
  signature or establish what upstream fields the opaque signature binds to.
- Only signatures losslessly representable as UTF-8 strings are supported.
  Binary or invalid UTF-8 values are rejected rather than Base64-rewritten.
- Native mode bypasses reasoning reclassification, empty-response rescue, and
  reasoning-to-content promotion. Once output is emitted, attempts cannot be
  concatenated. Any account failover revalidates signed history before transport.
- The initial supported client loop is Anthropic `/v1/messages` (also usable
  through an OpenAI client that explicitly persists `reasoning_content` and
  `reasoning_signature`). Gemini/Responses translation is not claimed to preserve
  these fields; do not enable replay for those client routes without separate tests.

## Verification

```bash
node --import ./test/setup-env.mjs --test test/devin-native-thinking.test.js
```

The tests cover mocked protobuf frames through the actual HTTP handlers,
session commit, adapters, client response reconstruction and next-request wire
encoding. Unit fixtures are explicitly synthetic. Real signature diagnostics
must compare bytes or hashes of actual upstream material without logging it.

Passing local tests proves transport fidelity, not upstream acceptance or task
quality. Before rollout, use isolated conversations and record model selector,
field types, lengths/hashes, tool IDs and terminal success. Compare quality,
latency and token cost separately; do not infer improvement from field presence.

Signed parallel replay was verified against `swe-2-high` on 2026-09-16: streamed
responses with two and three calls, reversed client result order, and a second
generation that correctly combined the tool values. Raw requests contained one
signed assistant message with all calls and exact upstream signature bytes/type.
This does not establish support for multiple/interleaved thinking blocks or for
other signed model selectors. The visible thinking text is a reasoning summary,
not evidence of the full internal reasoning contents of an opaque signature.
