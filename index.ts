/**
 * CoralBricks Provider Extension
 *
 * Registers CoralBricks as a custom provider using the openai-completions API.
 * Base URL: https://inference.coralbricks.ai/v1
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: authenticated /v1/models (authoritative enabled
 *      set + per-million USD pricing) with the unauthenticated public catalog
 *      (https://www.coralbricks.ai/api/public/models) as fallback
 *      → merge with embedded → cache → hot-swap
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Usage:
 *   # Option 1: Store in auth.json (recommended)
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "coralbricks": { "type": "api_key", "key": "cb_your-key" }
 *
 *   # Option 2: Set as environment variable
 *   # (localterm: `localterm secret set coralbricks_api_key` exposes CORALBRICKS_API_KEY)
 *   export CORALBRICKS_API_KEY=cb_your-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-coralbricks-provider
 *
 * Then use /model to select from available models
 */

import { getAgentDir, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEventStream, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { clampThinkingLevel, streamOpenAICompletions } from "@earendil-works/pi-ai/compat";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import deprecatedData from "./deprecated-models.json" with { type: "json" };
import fs from "fs";
import path from "path";

// Types

interface JsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: {
    off?: string | null;
    minimal?: string | null;
    low?: string | null;
    medium?: string | null;
    high?: string | null;
    xhigh?: string | null;
    max?: string | null;
  };
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    supportsReasoningEffort?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?: "openai" | "zai";
    supportsStrictMode?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
  };
}

interface PatchEntry {
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// Patch Application

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  // Deep-copy nested objects: the delete branches below must not mutate the
  // caller's (embedded or cached) source data through shared references.
  const result: JsonModel = {
    ...model,
    cost: { ...model.cost },
    compat: model.compat ? { ...model.compat } : undefined,
    thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
  };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = patch.thinkingLevelMap as JsonModel["thinkingLevelMap"];

  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }

  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (!result.reasoning && result.thinkingLevelMap) {
    delete result.thinkingLevelMap;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }

  return result;
}

/** Full pipeline: base models → patch → custom → result */
function buildModels(base: JsonModel[], custom: JsonModel[], patch: PatchData): JsonModel[] {
  const modelMap = new Map<string, JsonModel>();

  for (const model of withDeprecated(base)) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patchEntry = patch[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }

  return Array.from(modelMap.values());
}

// Stale-While-Revalidate Model Sync

const PROVIDER_ID = "coralbricks";
const BASE_URL = "https://inference.coralbricks.ai/v1";
const MODELS_URL = `${BASE_URL}/models`;
const PUBLIC_CATALOG_URL = "https://www.coralbricks.ai/api/public/models";
const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

// Output-token fallbacks for models whose API rows do not report a limit.
const DEFAULT_MAX_TOKENS: Record<string, number> = {
  "gpt-oss-120b": 40960,
};
const FALLBACK_MAX_TOKENS = 32768;

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function displayName(id: string): string {
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Parse "1M" / "128K" / "1048576" / 1048576 into a token count. */
function parseContextWindow(value: unknown, fallback = 131072): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const match = value.trim().match(/^([\d.]+)\s*([KkMm])$/);
    if (match) {
      const n = parseFloat(match[1]);
      if (Number.isFinite(n) && n > 0) {
        return Math.round(n * (match[2].toUpperCase() === "M" ? 1024 * 1024 : 1024));
      }
    }
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function baseCompat() {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens" as const,
  };
}

/**
 * Transform a Coral /v1/models row. Coral reports per-million USD pricing
 * (input_per_m / output_per_m / cached_input_per_m — cached reads are $0 on
 * every model), context_length, and supports_image_input.
 */
function transformApiModel(apiModel: any): JsonModel | null {
  if (!apiModel?.id) return null;
  const pricing = apiModel.pricing || {};
  const model: JsonModel = {
    id: apiModel.id,
    name: typeof apiModel.name === "string" && apiModel.name ? apiModel.name : displayName(apiModel.id),
    reasoning: false,
    input: apiModel.supports_image_input ? ["text", "image"] : ["text"],
    cost: {
      input: toNumber(pricing.input_per_m),
      output: toNumber(pricing.output_per_m),
      cacheRead: toNumber(pricing.cached_input_per_m),
      cacheWrite: 0,
    },
    contextWindow: parseContextWindow(apiModel.context_length),
    maxTokens: DEFAULT_MAX_TOKENS[apiModel.id] ?? FALLBACK_MAX_TOKENS,
  };
  model.compat = baseCompat();
  return model;
}

/**
 * Transform a row from the public model catalog
 * (https://www.coralbricks.ai/api/public/models) — the no-auth mirror of the
 * gateway control plane. Fields: slug, name, contextWindow ("1M"),
 * inputPerM / outputPerM. Coral's own prices are authoritative here; the
 * parity/field vendor comparison fields are ignored.
 */
function transformCatalogModel(entry: any): JsonModel | null {
  if (!entry?.slug) return null;
  const model: JsonModel = {
    id: entry.slug,
    name: typeof entry.name === "string" && entry.name ? entry.name : displayName(entry.slug),
    reasoning: false,
    input: ["text"],
    cost: {
      input: toNumber(entry.inputPerM),
      output: toNumber(entry.outputPerM),
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: parseContextWindow(entry.contextWindow),
    maxTokens: DEFAULT_MAX_TOKENS[entry.slug] ?? FALLBACK_MAX_TOKENS,
  };
  model.compat = baseCompat();
  return model;
}

async function fetchV1Models(apiKey: string, signal?: AbortSignal): Promise<JsonModel[] | null> {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const apiModels = Array.isArray(data) ? data : (data.data || []);
    if (!Array.isArray(apiModels) || apiModels.length === 0) return null;
    return apiModels.map(transformApiModel).filter((m): m is JsonModel => m !== null);
  } catch {
    return null;
  }
}

async function fetchPublicCatalog(signal?: AbortSignal): Promise<JsonModel[] | null> {
  try {
    const response = await fetch(PUBLIC_CATALOG_URL, {
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const entries = Array.isArray(data) ? data : (data.models || []);
    if (!Array.isArray(entries) || entries.length === 0) return null;
    return entries.map(transformCatalogModel).filter((m): m is JsonModel => m !== null);
  } catch {
    return null;
  }
}

/**
 * Live model fetch. The authenticated /v1/models is authoritative (it is the
 * exact per-key enabled set); the public catalog is the unauthenticated
 * fallback so model discovery works before a key is configured.
 */
async function fetchLiveModels(apiKey: string | undefined, signal?: AbortSignal): Promise<JsonModel[] | null> {
  if (apiKey) {
    const fromApi = await fetchV1Models(apiKey, signal);
    if (fromApi && fromApi.length > 0) return fromApi;
  }
  return fetchPublicCatalog(signal);
}

function loadCachedModels(): JsonModel[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheModels(models: JsonModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
  } catch {
    // Cache write failure is non-fatal
  }
}

function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
  const embeddedMap = new Map(embeddedModels.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const result: JsonModel[] = [];
  for (const liveModel of liveModels) {
    const embedded = embeddedMap.get(liveModel.id);
    seen.add(liveModel.id);
    if (embedded) {
      // Self-heal: live API pricing is authoritative field-by-field. Prefer the
      // live cost when the API reports it (non-zero); fall back to embedded when
      // the API is silent (0). Coral reports cached_input_per_m as 0 because
      // cached reads are free, which matches the curated cacheRead: 0.
      // Curation (reasoning/input/compat/name/thinkingLevelMap/maxTokens) still wins via ...embedded.
      result.push({
        ...liveModel,
        ...embedded,
        cost: {
          input: liveModel.cost.input || embedded.cost.input,
          output: liveModel.cost.output || embedded.cost.output,
          cacheRead: liveModel.cost.cacheRead || embedded.cost.cacheRead,
          cacheWrite: liveModel.cost.cacheWrite || embedded.cost.cacheWrite,
        },
        contextWindow: liveModel.contextWindow || embedded.contextWindow,
      });
    } else {
      result.push(liveModel);
    }
  }
  // Append any embedded models that the live API didn't return
  for (const em of embeddedModels) {
    if (!seen.has(em.id)) {
      result.push(em);
    }
  }
  return result;
}

// Grace period for delisted models. When the provider API stops listing a
// model, update-models.js moves its last-known definition into
// deprecated-models.json (stamped with deprecatedAt) instead of dropping it.
// For 14 days the model keeps working here so in-flight sessions and saved
// model settings do not break; afterwards it is evicted permanently.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Grace-period deprecated models with deprecation metadata stripped.
function activeDeprecatedModels(entries: Record<string, JsonModel & { deprecatedAt?: string }> = deprecatedData as Record<string, JsonModel & { deprecatedAt?: string }>): JsonModel[] {
  const now = Date.now();
  const result: JsonModel[] = [];
  for (const entry of Object.values(entries)) {
    if (!entry?.id) continue;
    const removedAt = Date.parse(entry.deprecatedAt ?? "");
    if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
    const model = { ...entry } as JsonModel & { deprecatedAt?: string };
    delete model.deprecatedAt;
    result.push(model);
  }
  return result;
}

// Append grace-period deprecated models the list does not already have (live data wins).
function withDeprecated(models: JsonModel[]): JsonModel[] {
  const seen = new Set(models.map((m) => m.id));
  const extras = activeDeprecatedModels().filter((m) => !seen.has(m.id));
  return extras.length > 0 ? [...models, ...extras] : models;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (!cached || cached.length === 0) return embeddedModels;

  // Merge embedded models that are missing from cache (newly added models)
  const cachedMap = new Map(cached.map((m) => [m.id, m]));
  for (const em of embeddedModels) {
    if (!cachedMap.has(em.id)) {
      cached.push(em);
    }
  }
  return cached;
}

async function revalidateModels(apiKey: string | undefined, embeddedModels: JsonModel[], signal?: AbortSignal): Promise<JsonModel[] | null> {
  const liveModels = await fetchLiveModels(apiKey, signal);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

// Streaming: Coral gateway tool-call index repair
//
// Some Coral models (observed on gpt-oss-120b) emit a streamed tool call's
// final arguments fragment on a NEW delta index instead of continuing the
// existing one:
//
//   {"tool_calls":[{"id":"call_1","index":0,"function":{"name":"get_weather","arguments":"{\"location\": \"Par"}}]}
//   {"tool_calls":[{"index":1,"function":{"arguments":"is\"}"}}]}   ← wrong index
//
// OpenAI semantics say a delta can only START a tool call when it carries an
// id (and a function name); continuations omit them. pi-ai's accumulator
// merges by index, so a mis-indexed fragment materializes a second, truncated
// tool call. Per choice, we track the index of the last fragment that carried
// id/name and rewrite id-less, name-less deltas that claim a different index
// onto it. Deltas that DO carry id/name (new calls, parallel calls) pass
// through untouched, as do Coral streams that are already correct (GLM/Kimi).

function repairToolCallIndices(chunk: any, lastToolCallIndex: Map<number, number>): boolean {
  const choices = chunk?.choices;
  if (!Array.isArray(choices)) return false;
  let changed = false;
  for (const choice of choices) {
    const toolCalls = choice?.delta?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;
    const choiceIndex = typeof choice.index === "number" ? choice.index : 0;
    for (const tc of toolCalls) {
      const hasId = typeof tc?.id === "string" && tc.id.length > 0;
      const hasName = typeof tc?.function?.name === "string" && tc.function.name.length > 0;
      if (hasId || hasName) {
        lastToolCallIndex.set(choiceIndex, tc.index);
        continue;
      }
      const previous = lastToolCallIndex.get(choiceIndex);
      if (previous !== undefined && typeof tc?.index === "number" && tc.index !== previous) {
        tc.index = previous;
        changed = true;
      }
    }
  }
  return changed;
}

function createToolCallIndexFixer(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const lastToolCallIndex = new Map<number, number>();
  let buffer = "";

  const fixLine = (line: string): string => {
    if (!line.startsWith("data:") || !line.includes("\"tool_calls\"")) return line;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return line;
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return line;
    }
    const changed = repairToolCallIndices(chunk, lastToolCallIndex);
    return changed ? "data: " + JSON.stringify(chunk) : line;
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        controller.enqueue(encoder.encode(fixLine(line) + "\n"));
      }
    },
    flush(controller) {
      if (buffer.length > 0) controller.enqueue(encoder.encode(fixLine(buffer)));
    },
  });
}

export function streamCoral(
  model: any,
  context: any,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const apiKey = options?.apiKey || cachedApiKey || "";
  if (!apiKey) {
    throw new Error(
      `No API key for CoralBricks. Add it to ~/.pi/agent/auth.json ` +
      `("coralbricks"), set CORALBRICKS_API_KEY, or use --api-key.`,
    );
  }

  // pi hands the user's thinking selection to streamSimple providers as
  // options.reasoning (a raw ThinkingLevel); streamOpenAICompletions reads
  // options.reasoningEffort, so replicate pi-ai's clamp+convert here.
  const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
  const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
  const { reasoning: _reasoning, ...streamOptions } = options ?? {};

  // Per-request fetch interceptor (never a global patch — concurrent agent and
  // helper-model streams must not see each other's wrappers).
  const upstreamFetch = streamOptions.fetch ?? globalThis.fetch;
  const coralFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await upstreamFetch(input as RequestInfo | URL, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const isEventStream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!response.body || !isEventStream || !url.includes("/chat/completions")) return response;
    return new Response(response.body.pipeThrough(createToolCallIndexFixer()), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };

  return streamOpenAICompletions(model, context, {
    ...streamOptions,
    fetch: coralFetch,
    reasoningEffort,
    apiKey,
  } as any);
}

// API Key Resolution (via ModelRegistry)

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = (await modelRegistry.getApiKeyForProvider(PROVIDER_ID)) ?? undefined;
}

// Extension Entry Point

export default function (pi: ExtensionAPI) {
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchData;

  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = buildModels(staleBase, customModels, patches);

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: BASE_URL,
    apiKey: "$CORALBRICKS_API_KEY",
    api: "openai-completions",
    models: staleModels,
    streamSimple: streamCoral,
  });

  pi.on("session_start", async (_event, ctx) => {
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    const signal = revalidateAbort.signal;
    resolveApiKey(ctx.modelRegistry).then(() => {
      revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
        if (freshBase && !signal.aborted) {
          pi.registerProvider(PROVIDER_ID, {
            baseUrl: BASE_URL,
            apiKey: "$CORALBRICKS_API_KEY",
            api: "openai-completions",
            models: buildModels(freshBase, customModels, patches),
            streamSimple: streamCoral,
          });
        }
      });
    });
  });

  pi.on("session_shutdown", () => {
    revalidateAbort?.abort();
  });
}

export { applyPatch, buildModels, mergeWithEmbedded, transformApiModel, transformCatalogModel, activeDeprecatedModels, withDeprecated, parseContextWindow, repairToolCallIndices, PROVIDER_ID, BASE_URL };
