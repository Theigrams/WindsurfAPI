# Local deployment patches

Base: upstream v3.9.34, commit `0c08524` (merged 2026-09-16).

The v3.9.34 merge retains the patches below. Upstream now merges adjacent
same-role text before Connect encoding and preserves Responses tool-output
images. The latter fixes `/v1/responses`; the local Anthropic image patch is
still required for `/v1/messages`. The local cache accounting and model-scoped
continuity files have no upstream changes in this release.

This checkout retains two deployed behavior fixes in `src/handlers/messages.js`:

- Report final upstream cache usage rather than treating requested cache prefixes
  as measured writes. Streaming start usage is zero until measurements arrive.
  A missing final input count may still use the existing input-only estimate.
- Preserve structured Anthropic tool-result images through the OpenAI intermediate
  representation so the Devin encoder receives image bytes. URL image parts remain
  structured, but the direct encoder does not fetch remote URLs.

Parallel tool-call/result pairing uses upstream's normalization layer. The former
local protobuf-encoder pairing implementation has been removed. Regression tests
exercise normalization followed by encoding, including out-of-order results,
reused IDs, pending calls, malformed histories, and multimodal results. Upstream
normalization pairs available matching results, retains pending calls, removes
orphan results, and carries reasoning on the first split assistant turn only.

The intermediate system-role fix is intentionally not part of this deployment.
The complete pre-upgrade local source and its regression tests are preserved in
branch `codex/windsurf-local-backup-20260914`, commit
`13cfe7a7958cdb5208555f416df3c0c80fb7b9f3`.

Focused verification:

```sh
node --import ./test/setup-env.mjs --test \
  test/devin-connect-tool-history.test.js \
  test/messages-cache-accounting.test.js \
  test/messages-tool-images.test.js \
  test/cache-control.test.js test/messages.test.js test/tool-emulation.test.js \
  test/session-continuity.test.js test/devin-connect.test.js \
  test/responses.test.js test/backend-router.test.js \
  test/devin-connect-models.test.js test/local-windsurf-import.test.js
```

The local continuity selector allowlist adds `DEVIN_CONNECT_SESSION_MODELS`.
When set to comma-separated upstream selectors, session lookup, ModelConfig
lookup, reasoning lookup, and successful-response commits only run for those
selectors. An unset allowlist preserves upstream's global-switch behavior.

The deployed SWE-2 configuration enables `DEVIN_CONNECT_SESSION_REUSE=1` and
`DEVIN_CONNECT_MODEL_CONFIG_STABLE=1`, restricted to `swe-2-medium,swe-2-high,swe-2-max`.
Reasoning injection remains off. Controlled experiments identified regenerated
ModelConfig IDs as a cause of cache misses; stable IDs restored measured cache
reads. This does not guarantee cache retention across all upstream requests.

Do not replace this checkout with a clean upstream tree without carrying the two
message-conversion patches and the continuity selector allowlist forward.
