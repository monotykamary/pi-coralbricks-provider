# pi-coralbricks-provider

[Coral Bricks](https://www.coralbricks.ai) provider extension for [pi](https://github.com/badlogic/pi-mono) — GLM 5.2/5.3, Kimi K3, and GPT-OSS 120B through the Coral Inference API with up to **1M token context**.

## Features

- **OpenAI-compatible**: uses the `openai-completions` API against `https://inference.coralbricks.ai/v1`
- **Stale-while-revalidate model sync**: embedded `models.json` loads instantly; the live catalog (`/v1/models`, or the unauthenticated [public catalog](https://www.coralbricks.ai/api/public/models) before auth) hot-swaps in on session start and self-heals pricing
- **Accurate costs**: pricing mirrors Coral's published per-million rates. Cached reads are billed at **$0** on every Coral model, so `cacheRead` is 0 across the catalog — pi's computed cost matches Coral's own `usage.cost`
- **Thinking levels wired per model family** (see table below)
- **Grace-period deprecation**: delisted models keep working for 14 days via `deprecated-models.json`
- **Patches & custom models**: `patch.json` overrides and `custom-models.json` additions applied on every load

## Install

```bash
pi -e /path/to/pi-coralbricks-provider
```

or install globally and add the extension path to your pi config.

## Authentication

Pick one:

1. **auth.json** (recommended) — add to `~/.pi/agent/auth.json`:

   ```json
   {
     "coralbricks": { "type": "api_key", "key": "cb_your-key" }
   }
   ```

2. **Environment variable** — `CORALBRICKS_API_KEY`. With [localterm](https://www.npmjs.com/package/localterm):

   ```bash
   localterm secret set coralbricks_api_key
   # exposes CORALBRICKS_API_KEY to sessions
   ```

Coral Inference is currently in a design-partner program — keys are minted at [coralbricks.ai/api-keys](https://www.coralbricks.ai/api-keys), and newly-minted keys may take ~30s to be honored.

## Available Models

| Model | Context | Vision | Reasoning | Input $/M | Cache Read $/M | Output $/M |
|-------|---------|--------|-----------|-----------|-----------------|------------|
| GLM 5.2 FP4 | 1.0M | ❌ | ✅ | $1.12 | — | $4.40 |
| GLM 5.3 FP4 | 1.0M | ❌ | ✅ | $1.12 | — | $4.40 |
| GPT-OSS 120B | 131K | ❌ | ✅ | $0.12 | — | $0.60 |
| Kimi K3 | 1.0M | ✅ | ✅ | $3.00 | — | $15.00 |

(Cache Read shows — because Coral bills cached input at $0 on every model.)

## Thinking levels

| Model | Format | off | low | medium | high | max |
|-------|--------|-----|-----|--------|------|-----|
| GLM 5.2 FP4 | `thinking: {type}` + `reasoning_effort` | ✅ (disabled) | — | ✅ | ✅ | ✅ |
| GLM 5.3 FP4 | `thinking: {type}` + `reasoning_effort` | ✅ (disabled) | ✅ | — | ✅ | ✅ |
| Kimi K3 | `reasoning_effort` | — (always thinks) | ✅ | — | ✅ | ✅ |
| GPT-OSS 120B | `reasoning_effort` | — | ✅ | ✅ | ✅ | — |

Verified against the live gateway:

- **GLM** accepts zai-style `thinking: {type: "disabled"}` — pi's *off* level genuinely disables thinking (the upstream Z.ai API does not, so this differs from the canonical Z.ai map).
- **Kimi K3** always thinks: `reasoning_effort: "none"` is accepted but does not disable reasoning, so *off* is intentionally not offered. Assistant replays include `reasoning_content` (`requiresReasoningContentOnAssistantMessages`).
- **GPT-OSS** exposes the standard low/medium/high reasoning efforts; reasoning arrives in `reasoning_content`.
- Coral streams both `reasoning_content` and a duplicate `reasoning` field; pi dedupes these automatically.

## Model catalog sync

```bash
node scripts/update-models.js              # fetch live catalog → models.json + README table
node scripts/update-models.js --readme-only  # regenerate the README table from local data
```

New models discovered by the sync land with API-derived defaults (`reasoning: false`, text-only) — curate `models.json` (or `patch.json`) for thinking/compat details.

## Inference-quality testing

This provider is validated with [synbad](https://github.com/synthetic-lab/synbad) (tool-calling + reasoning-parsing evals), run with `--count 1` in both unary and `--stream` modes:

```bash
CORALBRICKS_API_KEY=... node ../synbad/dist/source/index.js eval \
  --env-var CORALBRICKS_API_KEY \
  --base-url https://inference.coralbricks.ai/v1 \
  --model glm-5.3-fp4 --count 1
```

Results (synbad 0.0.8, `--count 1`, `--reasoning-effort high`, 15 evals per run):

| Model | Unary | Stream | Notes |
|-------|-------|--------|-------|
| GLM 5.2 FP4 | 15/15 ✅ | 15/15 ✅ | |
| GLM 5.3 FP4 | 15/15 ✅ | 15/15 ✅ | |
| Kimi K3 | 15/15 ✅ | 15/15 ✅ | |
| GPT-OSS 120B | 14/15 ⚠️ | 10–11/15 ❌ raw | see below |

### Coral streaming tool-call index bug (gpt-oss-120b)

On the raw wire, Coral occasionally emits a streamed tool call's final arguments fragment on a **new delta index** instead of continuing the existing one (`"index":1` mid-call), which fragments the call under any spec-compliant accumulator. GLM and Kimi streams are correct.

This extension patches around it transparently: `streamCoral` (the provider's `streamSimple`) pipes SSE responses through a repair stream that rewrites id-less, name-less tool-call deltas claiming a fresh index onto the last real call's index. With the patch, gpt-oss-120b streams produce complete tool calls (verified live: one `get_weather` call with well-formed arguments).

Remaining raw-wire quirks (not client-fixable):

- **gpt-oss unary `parallel-tool`**: the model answers "Paris and London" with a single batched call even when `parallel_tool_calls: true` — model behavior, not a gateway bug.

Diagnostic probe (streams a live tool call through the patched path):

```bash
CORALBRICKS_API_KEY=... bun run scripts/probe-stream-fix.ts [model-id]
```

## Troubleshooting

| Symptom | Meaning |
|---------|---------|
| `403 access_denied` | Account not on the Coral Inference allowlist yet |
| `404 model_not_accepted` | Model id not enabled for your key |
| `429 rate_limit_exceeded` | Per-key rate limit — retry with backoff |
| `502 upstream_error` / `503 backend_unconfigured` | Transient — retry |
| `504 timeout` | Sync request waited too long; re-issue smaller or use background mode via the Responses API |

## License

MIT
