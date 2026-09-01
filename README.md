<div align="center">

# 🪸 pi-coralbricks-provider

**GLM 5.2/5.3, Kimi K3 & GPT-OSS 120B through [Coral Bricks](https://www.coralbricks.ai)**

_A [pi](https://github.com/earendil-works/pi-coding-agent) provider extension for Coral's OpenAI-compatible inference gateway — up to **1M context** on open models._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![npm](https://img.shields.io/npm/v/pi-coralbricks-provider)](https://www.npmjs.com/package/pi-coralbricks-provider)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![synbad](https://img.shields.io/badge/synbad-evals_passing-brightgreen)](https://github.com/synthetic-lab/synbad)

</div>

---

## Features

- **4 reasoning models** from Coral's DynamoDB-backed live catalog — GLM 5.2 FP4, GLM 5.3 FP4, Kimi K3, and GPT-OSS 120B
- **1M token context** on GLM and Kimi, with vision (image input) on Kimi K3
- **OpenAI-compatible API** — standard `/v1/chat/completions`, streaming, and tool calling
- **Per-family thinking levels** — zai-style `thinking` control for GLM (including a *real* off switch), `reasoning_effort` for Kimi K3 and GPT-OSS
- **Accurate cost tracking** — pricing mirrors Coral's published rates, and cached reads are **$0 on every model**, so pi's computed cost matches Coral's own `usage.cost` to the token
- **Self-healing model sync** — stale-while-revalidate from the authenticated `/v1/models` (or the unauthenticated [public catalog](https://www.coralbricks.ai/api/public/models) before auth), hot-swapped at session start
- **Streaming repair** — transparently fixes Coral's gpt-oss tool-call delta index fragmentation so streamed tool calls always accumulate correctly
- **synbad-validated** — [synbad](https://github.com/synthetic-lab/synbad) tool-calling and reasoning-parsing evals pass 15/15 on GLM 5.2, GLM 5.3, and Kimi K3 in both unary and streaming modes

## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install https://github.com/monotykamary/pi-coralbricks-provider
```

or from npm:

```bash
pi install npm:pi-coralbricks-provider
```

Then set your API key and run pi:

```bash
# Recommended: add to auth.json
# See Authentication section below

# Or set as environment variable
export CORALBRICKS_API_KEY=cb_your-key-here

pi
```

### Option 2: Manual Clone

1. Clone this repository:
   ```bash
   git clone https://github.com/monotykamary/pi-coralbricks-provider.git
   cd pi-coralbricks-provider
   bun install
   ```

2. Set your Coral API key:
   ```bash
   # Recommended: add to auth.json
   # See Authentication section below

   # Or set as environment variable
   export CORALBRICKS_API_KEY=cb_your-key-here
   ```

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-coralbricks-provider
   ```

## Available Models

| Model | Context | Vision | Reasoning | Input $/M | Cache Read $/M | Output $/M |
|-------|---------|--------|-----------|-----------|-----------------|------------|
| GLM 5.2 FP4 | 1.0M | ❌ | ✅ | $1.12 | — | $4.40 |
| GLM 5.3 FP4 | 1.0M | ❌ | ✅ | $1.12 | — | $4.40 |
| GPT-OSS 120B | 131K | ❌ | ✅ | $0.12 | — | $0.60 |
| Kimi K3 | 1.0M | ✅ | ✅ | $3.00 | — | $15.00 |

*Costs are per million tokens. Cache Read shows — because Coral bills cached input at **$0** on every model. Prices subject to change — check [Coral's live catalog](https://www.coralbricks.ai/api/public/models).*

## Usage

After loading the extension, use the `/model` command in pi to select your preferred model:

```
/model coralbricks glm-5.3-fp4
```

Or start pi directly with a Coral model:

```bash
pi -e /path/to/pi-coralbricks-provider --model coralbricks/kimi-k3:high
```

Thinking levels attach to the model id with `:<level>` — e.g. `:low`, `:high`, `:max`, or `:off` (GLM only).

## Authentication

The Coral API key can be configured in multiple ways (resolved in this order):

1. **`auth.json`** (recommended) — Add to `~/.pi/agent/auth.json`:
   ```json
   { "coralbricks": { "type": "api_key", "key": "cb_your-key" } }
   ```
   The `key` field supports literal values, env var names, and shell commands (prefix with `!`).
2. **Runtime override** — Use the `--api-key` CLI flag
3. **Environment variable** — Set `CORALBRICKS_API_KEY`

With [localterm](https://www.npmjs.com/package/localterm), store it once and it's exposed everywhere:

```bash
localterm secret set coralbricks_api_key
```

> Coral Inference is currently in a design-partner program — mint keys at [coralbricks.ai/api-keys](https://www.coralbricks.ai/api-keys). Newly-minted keys may take ~30 seconds to be honored, and `403 access_denied` means the account isn't on the allowlist yet.

## Thinking Levels

Verified against the live gateway:

| Model | Format | off | low | medium | high | max |
|-------|--------|-----|-----|--------|------|-----|
| GLM 5.2 FP4 | `thinking: {type}` + `reasoning_effort` | ✅ | — | ✅ | ✅ | ✅ |
| GLM 5.3 FP4 | `thinking: {type}` + `reasoning_effort` | ✅ | ✅ | — | ✅ | ✅ |
| Kimi K3 | `reasoning_effort` | — | ✅ | — | ✅ | ✅ |
| GPT-OSS 120B | `reasoning_effort` | — | ✅ | ✅ | ✅ | — |

- **GLM** accepts zai-style `thinking: {type: "disabled"}` on Coral — pi's *off* level genuinely disables thinking (the upstream Z.ai API does not, so this differs from the canonical Z.ai map).
- **Kimi K3** always thinks: `reasoning_effort: "none"` is accepted but doesn't disable reasoning, so *off* is intentionally not offered. Assistant replays include `reasoning_content`.
- **GPT-OSS** exposes the standard low/medium/high reasoning efforts; reasoning arrives in `reasoning_content`.
- Coral streams a duplicate `reasoning` field alongside `reasoning_content`; pi dedupes these automatically.

## Compat Settings

Coral's gateway follows the OpenAI Chat Completions API:

- **`supportsStore: false`** / **`supportsDeveloperRole: false`** — all models; Coral serves open models on the classic roles.
- **`maxTokensField: "max_tokens"`** — all models.
- **`thinkingFormat: "zai"`** — GLM 5.2/5.3: `thinking: {type: "enabled"|"disabled"}` toggles reasoning, `reasoning_effort` picks the depth.
- **`thinkingFormat: "openai"`** — Kimi K3 and GPT-OSS 120B: `reasoning_effort` drives thinking depth.
- **`supportsStrictMode: false`** — Kimi K3 (no strict JSON-schema tool definitions).
- **`requiresReasoningContentOnAssistantMessages: true`** — Kimi K3.

### Streaming Tool-Call Repair

On the raw wire, Coral occasionally emits a streamed tool call's final arguments fragment on a **new delta index** instead of continuing the existing one (`"index": 1` mid-call), which fragments the call under any spec-compliant accumulator. Observed on gpt-oss-120b; GLM and Kimi streams are correct.

This extension's `streamSimple` pipes SSE responses through a repair stream that rewrites id-less, name-less tool-call deltas claiming a fresh index onto the last real call's index. Deltas that do carry an id/name (new calls, parallel calls) pass through untouched, and streams that are already correct are byte-identical. Verify against a live model:

```bash
CORALBRICKS_API_KEY=cb_... bun run scripts/probe-stream-fix.ts [model-id]
```

### Patch Overrides & Custom Models

- **`patch.json`** — per-model overrides applied on top of `models.json` (reasoning flags, pricing corrections, compat settings, thinking level maps). Currently empty — the curated defaults match the live API.
- **`custom-models.json`** — full model definitions for models Coral doesn't list. Merged after patch.

Merge order: `[live|cache|embedded] → patch.json → custom-models.json`

## Inference-Quality Testing

Validated with [synbad](https://github.com/synthetic-lab/synbad) — Synthetic's tool-calling and reasoning-parsing eval suite for LLM inference providers (`--count 1`, `--reasoning-effort high`, 15 evals per run):

| Model | Unary | Stream | Notes |
|-------|-------|--------|-------|
| GLM 5.2 FP4 | 15/15 ✅ | 15/15 ✅ | |
| GLM 5.3 FP4 | 15/15 ✅ | 15/15 ✅ | |
| Kimi K3 | 15/15 ✅ | 15/15 ✅ | |
| GPT-OSS 120B | 14/15 ⚠️ | 10–11/15 ❌ raw | repaired in-extension (see above) |

The remaining gpt-oss quirk is model-side: it answers "Paris and London" with a single batched tool call even when `parallel_tool_calls: true` — not a gateway bug.

Reproduce:

```bash
CORALBRICKS_API_KEY=cb_... node ../synbad/dist/source/index.js eval \
  --env-var CORALBRICKS_API_KEY \
  --base-url https://inference.coralbricks.ai/v1 \
  --model glm-5.3-fp4 --count 1 --reasoning-effort high
```

## Updating Models

Run the update script to fetch the latest models from Coral's API:

```bash
export CORALBRICKS_API_KEY=cb_your-key
node scripts/update-models.js
```

This will:
1. Fetch models from `https://inference.coralbricks.ai/v1/models` (falls back to the unauthenticated [public catalog](https://www.coralbricks.ai/api/public/models) without a key)
2. Preserve existing model data (pricing, compat, thinking maps) for known models
3. Apply overrides from `patch.json`
4. Update `models.json` and the README model table

To regenerate just the README model table from local data — no API key needed:

```bash
node scripts/update-models.js --readme-only
```

## Troubleshooting

| Symptom | Meaning |
|---------|---------|
| `403 access_denied` | Account not on the Coral Inference allowlist yet |
| `404 model_not_accepted` | Model id not enabled for your key |
| `401 invalid_api_key` | Re-mint at [coralbricks.ai/api-keys](https://www.coralbricks.ai/api-keys); fresh keys take ~30s to activate |
| `429 rate_limit_exceeded` | Per-key rate limit — retry with backoff |
| `502 upstream_error` / `503 backend_unconfigured` | Transient — retry |
| `504 timeout` | Sync request waited too long; re-issue smaller or use Coral's background Responses API |

## License

MIT
