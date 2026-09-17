# Local feature stack on upstream 3.9.37

Base: upstream `35787a8817307830e23ee9f0f867215aea5c1562`, verified against
`dwgx/WindsurfAPI` master on 2026-09-18. The package version remains upstream's
3.9.37. This document supersedes the old 3.9.34 deployment-specific
`LOCAL_PATCHES.md`; it describes source integration, not a production deployment.

## Functional commits

Apply the six commits in order. Each layer includes its relevant tests and
mutation-anchor/baseline updates, so a later feature is not required to make an
earlier layer's tests load.

| Layer | Function | Original local commits carried forward |
|---|---|---|
| 1 | Measured Anthropic cache accounting and structured tool-result images | `fddc459` and the retained local parts of `030dbf1` |
| 2 | Model-selector allowlist for session/ModelConfig/reasoning continuity | `36be588` |
| 3 | Agent SDK subagent identity and complete style-instruction normalization | `79cbd4e` |
| 4 | Native thinking/signature transport, signed parallel history, durable provenance and sessions | `dcca6db`, unsigned legacy handling from `82ea6ff`, `2e66d1d`, `a163b83`, `5304f1a`, `d108d92` |
| 5 | Foreign-signature compatibility outside the native replay allowlists | New mixed-provider fix, including the relevant Cascade follow-up from `f786009` |
| 6 | Messages Identity V2 with verified legacy aliases | `c83b2ab` and alias-file ignore rules |

The old rebase's catch-all `f786009` follow-up is folded into its owning features.
Layer 4 contains the corrected independent native capacity, admission on legacy
promotion, deferred eviction after successful persistence, single retention
renewal per attempt, nonempty caller scope, and matching stream/generate native
tool argument handling. Its restored `connect-error-blame` regressions verify
that local provenance/storage failures do not penalize a healthy account.

Intermediate commits keep native thinking opt-in. Layer 4 retains the previously
deployed conservative handling of foreign history; layer 5 replaces it with the
mixed-provider compatibility policy below. The complete six-layer tip is the
integration candidate.

## Foreign thinking policy

Policy is keyed by the final resolved selector and explicit allowlists. A model
family prefix is not proof of an upstream signature protocol. The registry records
signatures produced by upstream; this gateway does not mint or decrypt them.

| Target policy | Incoming thinking/signature handling |
|---|---|
| Signed allowlist, e.g. explicitly configured `swe-2-high` | Full caller/model/account/session/summary/retention validation; unknown or mismatched signatures rejected before upstream transport |
| Text allowlist, e.g. explicitly configured `deepseek-v4-1-flash-high` | Preserve the unsigned summary; remove signature and type metadata |
| Outside both lists, including `glm-5-3-flash-high` or unlisted Claude/SWE selectors | Remove native thinking/signature metadata before tool-history normalization; ordinary text, calls and results remain |
| Native feature disabled | Preserve the legacy feature-off behavior |

When native policy is enabled, the older `DEVIN_CONNECT_REPLAY_REASONING` probe
cannot reintroduce unsigned thinking for an unlisted selector. When native policy
is disabled, explicitly requested legacy probes retain their existing behavior.

`test/foreign-thinking-http.test.js` covers the exact GLM and Claude selectors,
stream/generate and ordinary/parallel-tool histories through the real Messages
handler and protobuf encoder with only upstream HTTPS mocked. It checks field 21
for the exact selector and absence of fields 11/12/18. The lower-level policy
matrix also covers legacy probe settings 0/1/9 and signed/text control cases.
Fixtures are synthetic; these tests do not claim that a particular provider's
opaque signature is cryptographically valid.

## Preserved upstream behavior and intentional omissions

- Keep upstream 3.9.37 history normalization, indexed session ownership,
  schema/preamble changes, catalog and routing updates. Do not restore the old
  parallel-pairing encoder over upstream's normalizer.
- The earlier intermediate system-role workaround preserved only in
  `codex/windsurf-local-backup-20260914` was withdrawn before deployment. It is
  not revived. The retained `5304f1a` role provenance uses internal Symbols for
  session matching and does not serialize extra role fields.
- Historical backup branches, runtime credentials, account records and native
  metadata files remain operational state, not source commits.
- Signed provenance and session storage remain version 1. The local metadata
  reader was verified against isolated copies of the existing production files;
  production files and the production process were not modified by integration.

## Validation boundaries

Each feature commit has focused test evidence. The final release suite uses
Node 24 and the repository's isolated per-file runner; mutation checks use the
structured reporter and never `--test-force-exit`. The independent default-wire
matrix compares 270 cases against the clean upstream base.

Two existing Node 24/environment-sensitive assertions reproduce on the bare
upstream base: `account-add-proxy-ordering.test.js` and
`s1-p1-cache-key-error-path.test.js`. They are reported separately; they are not
silently marked as passing or skipped.

Real isolated HTTP and CPA checks already cover SWE-2 signed linear/tool/image
replay and DeepSeek V4.1 Flash unsigned/parallel/image replay. Preserve their
scope: this is not a full public Caddy/8317/client-UI or multi-account failover
acceptance run. SWE-2 produced sequential calls in the current live probes, so
current signed parallel-batch acceptance is not inferred from local tests.

See [NATIVE-THINKING.md](NATIVE-THINKING.md) for protocol limits and
[MESSAGES-IDENTITY-V2.md](MESSAGES-IDENTITY-V2.md) for migration constraints.
In particular, a background branch advancing a shared history can still prevent
an older main branch from resuming its signed session. This existing phase-2
limitation was reproduced against real SWE-2; it is not expanded into this
integration's feature scope. Token/account/model changes do not gain signature
portability through this integration.
