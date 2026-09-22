<div align="center">

# 🪸 pi-coralbricks-provider

**GLM 5.3, GLM 5.3 Flash, DeepSeek V4.1 Flash & GPT-OSS 120B through [Coral Bricks](https://www.coralbricks.ai)**

_A [pi](https://github.com/earendil-works/pi-coding-agent) provider extension for Coral's OpenAI-compatible inference gateway — up to **1M context** on open models._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![npm](https://img.shields.io/npm/v/pi-coralbricks-provider)](https://www.npmjs.com/package/pi-coralbricks-provider)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![synbad](https://img.shields.io/badge/synbad-evals_passing-brightgreen)](https://github.com/synthetic-lab/synbad)

</div>

---

## Features

- **4 reasoning models** from Coral's live catalog — GLM 5.3 FP4, GLM 5.3 Flash, DeepSeek V4.1 Flash, and GPT-OSS 120B
- **1M token context** on GLM and DeepSeek, with vision (image input) on GLM 5.3 Flash and DeepSeek V4.1 Flash
- **OpenAI-compatible API** — standard `/v1/chat/completions`, streaming, and tool calling
- **Per-family thinking levels** — zai-style `thinking` control for GLM (including a *real* off switch), `reasoning_effort` for DeepSeek V4.1 Flash and GPT-OSS
- **Accurate cost tracking** — input, cache-write and output rates mirror Coral's [published pricing](https://www.coralbricks.ai/pricing), and cached reads are **$0 on every model**
- **Self-healing model sync** — stale-while-revalidate from the authenticated `/v1/models` (or the unauthenticated [public catalog](https://www.coralbricks.ai/api/public/models) before auth), hot-swapped at session start
- **synbad-validated** — [synbad](https://github.com/synthetic-lab/synbad) tool-calling and reasoning-parsing evals pass 13/13 in every run on GLM 5.3 in both unary and streaming modes

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

| Model | Context | Vision | Reasoning | Input $/M | Cache Read $/M | Cache Write $/M | Output $/M |
|-------|---------|--------|-----------|-----------|-----------------|------------------|------------|
| DeepSeek V4.1 Flash | 1.0M | ✅ | ✅ | $0.30 | — | $0.09 | $1.20 |
| GLM 5.3 Flash | 1.0M | ✅ | ✅ | $0.15 | — | $0.23 | $0.50 |
| GLM 5.3 FP4 | 1.0M | ❌ | ✅ | $1.12 | — | $1.68 | $4.40 |
| GPT-OSS 120B | 131K | ❌ | ✅ | $0.12 | — | $0.18 | $0.60 |

*Costs are per million tokens. Cache Read shows — because Coral bills cached input at **$0** on every model. Prompt tokens Coral has not cached yet are billed once at the Cache Write rate, in place of the Input rate. Prices subject to change — check [Coral's live catalog](https://www.coralbricks.ai/api/public/models).*

## Usage

After loading the extension, use the `/model` command in pi to select your preferred model:

```
/model coralbricks glm-5.3-fp4
```

Or start pi directly with a Coral model:

```bash
pi -e /path/to/pi-coralbricks-provider --model coralbricks/deepseek-v4.1-flash-fast-fp4:high
```

Thinking levels attach to the model id with `:<level>` — e.g. `:low`, `:high`, `:max`, or `:off` (GLM and DeepSeek).

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
| GLM 5.3 FP4 | `thinking: {type}` + `reasoning_effort` | ✅ | ✅ | — | ✅ | ✅ |
| GLM 5.3 Flash | `thinking: {type}` + `reasoning_effort` | ✅ | ✅ | — | ✅ | ✅ |
| DeepSeek V4.1 Flash | `reasoning_effort` | ✅ | ✅ | — | ✅ | ✅ |
| GPT-OSS 120B | `reasoning_effort` | — | ✅ | ✅ | ✅ | — |

- **GLM** accepts zai-style `thinking: {type: "disabled"}` on Coral — pi's *off* level turns thinking off, though a short preamble of a few dozen tokens can still appear (the upstream Z.ai API has no off at all, so this differs from the canonical Z.ai map).
- **DeepSeek V4.1 Flash** reasons only when asked: a request without `reasoning_effort`, or with `"none"`, gets no reasoning, which is what pi's *off* sends. `thinking: {type}` has no effect on this model.
- **GPT-OSS** exposes the standard low/medium/high reasoning efforts; reasoning arrives in `reasoning_content`.
- Coral streams a duplicate `reasoning` field alongside `reasoning_content`; pi dedupes these automatically.

## Compat Settings

Coral's gateway follows the OpenAI Chat Completions API:

- **`supportsStore: false`** / **`supportsDeveloperRole: false`** — all models; Coral serves open models on the classic roles.
- **`maxTokensField: "max_tokens"`** — all models.
- **`thinkingFormat: "zai"`** — GLM 5.3: `thinking: {type: "enabled"|"disabled"}` toggles reasoning, `reasoning_effort` picks the depth.
- **`thinkingFormat: "openai"`** — DeepSeek V4.1 Flash and GPT-OSS 120B: `reasoning_effort` drives thinking depth.

### Patch Overrides & Custom Models

- **`patch.json`** — per-model overrides applied on top of `models.json` (reasoning flags, pricing corrections, compat settings, thinking level maps). Currently carries two entries: GLM 5.3 Flash (reasoning, image input, its thinking level map and compat settings) and DeepSeek V4.1 Flash (reasoning, its thinking level map and compat settings).
- **`custom-models.json`** — full model definitions for models Coral doesn't list. Merged after patch.

Merge order: `[live|cache|embedded] → patch.json → custom-models.json`

## Inference-Quality Testing

Validated with [synbad](https://github.com/synthetic-lab/synbad) — Synthetic's tool-calling and reasoning-parsing eval suite for LLM inference providers (current 13-eval suite, `--reasoning-effort high`, five `--count 1` runs per mode on 2026-09-15; a cell shows the evals that passed in every run):

| Model | Unary | Stream | Notes |
|-------|-------|--------|-------|
| GLM 5.3 FP4 | 13/13 ✅ | 13/13 ✅ | 5/5 runs |
| GLM 5.3 Flash | 12/13 ⚠️ | 12/13 ⚠️ | `reasoning/reasoning-parsing` passes 4 of 5 runs; see below |
| GPT-OSS 120B | 12/13 ⚠️ | 12/13 ⚠️ | `tools/parallel-tool` 0 of 5 runs; see below |
| Kimi K3 (retired) | 13/13 ✅ | 13/13 ✅ | 5/5 runs, before Coral retired the model |
| GLM 5.2 FP4 (retired) | 15/15 ✅ | 15/15 ✅ | 15-eval suite, single run, before Coral retired the model |

The two misses are model-side, not transport: gpt-oss answers "Paris and London" with one call after another instead of two parallel calls even when `parallel_tool_calls: true`, in every run; and on the trivial prompt `reasoning-parsing` uses, GLM 5.3 Flash answers without a think block about one run in five, in both modes, with the answer itself unaffected.

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
