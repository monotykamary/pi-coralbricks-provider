import { describe, expect, it } from "vitest";
import {
  activeDeprecatedModels,
  applyPatch,
  buildModels,
  mergeWithEmbedded,
  parseContextWindow,
  repairToolCallIndices,
  transformApiModel,
  transformCatalogModel,
  withDeprecated,
} from "../index";
import modelsData from "../models.json" with { type: "json" };
import customModelsData from "../custom-models.json" with { type: "json" };
import patchData from "../patch.json" with { type: "json" };
import deprecatedData from "../deprecated-models.json" with { type: "json" };

const DEPRECATED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// A Coral /v1/models row shaped exactly as the gateway returns it.
const v1KimiRow = {
  id: "kimi-k3",
  object: "model",
  owned_by: "coralbricks",
  context_length: 1048576,
  created: 1787000000,
  pricing: { cached_input_per_m: 0, input_per_m: 3, output_per_m: 15 },
  supports_chat: true,
  supports_image_input: true,
  supports_tools: true,
};

// A public-catalog row shaped exactly as /api/public/models returns it.
const catalogGlmRow = {
  slug: "glm-5.3-fp4",
  name: "GLM 5.3",
  contextWindow: "1M",
  precision: "FP4",
  inputPerM: 1.12,
  outputPerM: 4.4,
  kvBytesPerToken: 47616,
  docsUrl: "https://huggingface.co/zai-org/GLM-5.3",
  parityVendor: { source: "Z.ai", inputPerM: 1.4, cachedPerM: 0.26, cacheWritePerM: 0, outputPerM: 4.4 },
  fieldVendor: { source: "Z.ai", inputPerM: 1.4, cachedPerM: 0.26, cacheWritePerM: 0, outputPerM: 4.4 },
};

describe("transformApiModel (/v1/models rows)", () => {
  it("maps pricing, context, and image support", () => {
    const m = transformApiModel(v1KimiRow)!;
    expect(m.id).toBe("kimi-k3");
    expect(m.input).toEqual(["text", "image"]);
    expect(m.cost).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
    expect(m.contextWindow).toBe(1048576);
    expect(m.compat?.supportsStore).toBe(false);
    expect(m.compat?.supportsDeveloperRole).toBe(false);
    expect(m.compat?.maxTokensField).toBe("max_tokens");
  });

  it("keeps Coral's free cached reads at cacheRead: 0", () => {
    const m = transformApiModel({ ...v1KimiRow, pricing: { cached_input_per_m: 0, input_per_m: 3, output_per_m: 15 } })!;
    expect(m.cost.cacheRead).toBe(0);
  });

  it("defaults new models to text-only and applies per-id maxTokens fallbacks", () => {
    const gpt = transformApiModel({ id: "gpt-oss-120b", context_length: 131072, pricing: {} })!;
    expect(gpt.input).toEqual(["text"]);
    expect(gpt.maxTokens).toBe(40960);

    const unknown = transformApiModel({ id: "some-new-model", pricing: {} })!;
    expect(unknown.maxTokens).toBe(32768);
    expect(unknown.contextWindow).toBe(131072);
  });

  it("returns null for rows without an id", () => {
    expect(transformApiModel(null)).toBeNull();
    expect(transformApiModel({})).toBeNull();
  });
});

describe("transformCatalogModel (public catalog rows)", () => {
  it("parses '1M' context strings and Coral's own prices", () => {
    const m = transformCatalogModel(catalogGlmRow)!;
    expect(m.id).toBe("glm-5.3-fp4");
    expect(m.contextWindow).toBe(1048576);
    expect(m.cost.input).toBe(1.12);
    expect(m.cost.output).toBe(4.4);
    expect(m.cost.cacheRead).toBe(0);
  });

  it("ignores parity/field vendor pricing", () => {
    const m = transformCatalogModel(catalogGlmRow)!;
    expect(m.cost.input).not.toBe(1.4);
  });

  it("returns null for rows without a slug", () => {
    expect(transformCatalogModel(null)).toBeNull();
    expect(transformCatalogModel({})).toBeNull();
  });
});

describe("parseContextWindow", () => {
  it("handles M/K strings, numerics, and garbage", () => {
    expect(parseContextWindow("1M")).toBe(1048576);
    expect(parseContextWindow("128K")).toBe(131072);
    expect(parseContextWindow("1048576")).toBe(1048576);
    expect(parseContextWindow(262144)).toBe(262144);
    expect(parseContextWindow("bogus")).toBe(131072);
  });
});

describe("applyPatch", () => {
  const base = modelsData.find((m) => m.id === "glm-5.3-fp4")!;

  it("merges cost fields selectively", () => {
    const patched = applyPatch(base, { cost: { output: 5 } });
    expect(patched.cost.output).toBe(5);
    expect(patched.cost.input).toBe(base.cost.input);
    expect(patched.cost.cacheRead).toBe(0);
  });

  it("merges compat without dropping existing keys", () => {
    const patched = applyPatch(base, { compat: { supportsStrictMode: false } });
    expect(patched.compat?.thinkingFormat).toBe("zai");
    expect(patched.compat?.supportsStrictMode).toBe(false);
  });

  it("strips thinking config when reasoning is turned off", () => {
    const patched = applyPatch(base, { reasoning: false });
    expect(patched.reasoning).toBe(false);
    expect(patched.compat?.thinkingFormat).toBeUndefined();
    expect(patched.thinkingLevelMap).toBeUndefined();
  });
});

describe("buildModels pipeline", () => {
  it("applies patch.json on top of base models", () => {
    const patch = { "glm-5.3-fp4": { name: "GLM 5.3 (patched)" } };
    const models = buildModels(modelsData as any, [], patch);
    const glm = models.find((m) => m.id === "glm-5.3-fp4");
    expect(glm?.name).toBe("GLM 5.3 (patched)");
  });

  it("ignores patch entries for unknown ids", () => {
    const models = buildModels(modelsData as any, [], { "no-such-model": { name: "x" } });
    expect(models.find((m) => m.id === "x")).toBeUndefined();
    expect(models.length).toBe(withDeprecated(modelsData as any).length);
  });

  it("adds custom models and applies their patches", () => {
    const custom = [{ ...modelsData[0], id: "router-model" }];
    const patch = { "router-model": { reasoning: false } };
    const models = buildModels(modelsData as any, custom as any, patch);
    const router = models.find((m) => m.id === "router-model");
    expect(router).toBeDefined();
    expect(router?.reasoning).toBe(false);
    expect(router?.compat?.thinkingFormat).toBeUndefined();
  });
});

describe("mergeWithEmbedded (live vs curated)", () => {
  it("keeps curated compat/thinking over live rows while live cost wins", () => {
    const live = transformApiModel({ ...v1KimiRow, pricing: { cached_input_per_m: 0, input_per_m: 5, output_per_m: 20 } })!;
    const merged = mergeWithEmbedded([live], modelsData as any);
    const kimi = merged.find((m) => m.id === "kimi-k3")!;
    expect(kimi.cost.input).toBe(5);
    expect(kimi.cost.output).toBe(20);
    expect(kimi.compat?.thinkingFormat).toBe("openai");
    expect(kimi.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
    expect(kimi.thinkingLevelMap).toBeDefined();
    expect(kimi.input).toEqual(["text", "image"]);
  });

  it("appends embedded-only models (delisted from live)", () => {
    const live = [transformApiModel({ id: "brand-new-model", pricing: { input_per_m: 1, output_per_m: 2 } })!];
    const merged = mergeWithEmbedded(live, modelsData as any);
    expect(merged.some((m) => m.id === "kimi-k3")).toBe(true);
    expect(merged.some((m) => m.id === "brand-new-model")).toBe(true);
  });
});

describe("deprecated model grace period", () => {
  it("keeps recently deprecated models and evicts stale ones", () => {
    const fresh = Date.now() - 1000;
    const ancient = Date.now() - DEPRECATED_TTL_MS - 1000;
    const iso = (t: number) => new Date(t).toISOString();
    const active = activeDeprecatedModels({
      "gone-model": { ...(modelsData[0] as any), id: "gone-model", deprecatedAt: iso(fresh) },
      "old-model": { ...(modelsData[0] as any), id: "old-model", deprecatedAt: iso(ancient) },
    });
    expect(active.map((m) => m.id)).toEqual(["gone-model"]);
    expect(active[0].deprecatedAt).toBeUndefined();
  });

  it("withDeprecated appends only missing deprecated models", () => {
    const base = [{ ...modelsData[0], id: "live-model" }];
    const extras = activeDeprecatedModels();
    const result = withDeprecated(base as any);
    expect(result.map((m) => m.id)).toEqual([...base.map((m) => m.id), ...extras.map((m) => m.id)]);

    const existing = [...base, ...extras];
    expect(withDeprecated(existing as any)).toHaveLength(existing.length);
  });
});

describe("embedded model catalog invariants", () => {
  const models = modelsData as any[];
  const deprecatedModels = Object.values(deprecatedData) as any[];
  const catalog = [...models, ...deprecatedModels];

  it("separates current and recently removed Coral models", () => {
    expect(models.map((m) => m.id).sort()).toEqual(["glm-5.3-fp4", "gpt-oss-120b", "kimi-k3"]);
    expect(deprecatedModels.map((m) => m.id)).toEqual(["glm-5.2-fp4"]);
  });

  it("has well-formed costs with free cached reads", () => {
    for (const m of models) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        expect(typeof m.cost[key]).toBe("number");
      }
      expect(m.cost.cacheRead).toBe(0); // Coral: cached input is free
      expect(m.cost.cacheWrite).toBe(0);
      expect(m.contextWindow).toBeGreaterThanOrEqual(131072);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
  });

  it("keeps pricing aligned with Coral's published rates", () => {
    const byId = Object.fromEntries(catalog.map((m) => [m.id, m]));
    expect(byId["glm-5.2-fp4"].cost).toMatchObject({ input: 1.12, output: 4.4 });
    expect(byId["glm-5.3-fp4"].cost).toMatchObject({ input: 1.12, output: 4.4 });
    expect(byId["kimi-k3"].cost).toMatchObject({ input: 3, output: 15 });
    expect(byId["gpt-oss-120b"].cost).toMatchObject({ input: 0.12, output: 0.6 });
  });

  it("gives every reasoning model a thinkingLevelMap and thinkingFormat", () => {
    for (const m of models) {
      expect(m.reasoning).toBe(true);
      expect(m.thinkingLevelMap).toBeDefined();
      expect(m.compat?.thinkingFormat).toBeDefined();
      expect(m.compat?.supportsStore).toBe(false);
      expect(m.compat?.supportsDeveloperRole).toBe(false);
    }
  });

  it("maps thinking levels per upstream model family", () => {
    const byId = Object.fromEntries(catalog.map((m) => [m.id, m]));
    // GLM 5.2: zai format, off→disabled + high/max efforts
    expect(byId["glm-5.2-fp4"].compat?.thinkingFormat).toBe("zai");
    expect(byId["glm-5.2-fp4"].thinkingLevelMap).toMatchObject({ off: "none", high: "high", max: "max" });
    // GLM 5.3 adds a low effort
    expect(byId["glm-5.3-fp4"].thinkingLevelMap).toMatchObject({ off: "none", low: "low", high: "high", max: "max" });
    // Kimi K3: openai reasoning_effort, no off (thinking cannot be disabled), low/high/max
    expect(byId["kimi-k3"].compat?.thinkingFormat).toBe("openai");
    expect(byId["kimi-k3"].thinkingLevelMap).toMatchObject({ off: null, low: "low", high: "high", max: "max" });
    expect(byId["kimi-k3"].compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
    // gpt-oss: low/medium/high reasoning_effort
    expect(byId["gpt-oss-120b"].thinkingLevelMap).toMatchObject({ low: "low", medium: "medium", high: "high" });
  });

  it("flags kimi-k3 vision from the live API flag", () => {
    const kimi = models.find((m) => m.id === "kimi-k3")!;
    expect(kimi.input).toContain("image");
  });

  it("starts with empty patch/custom sources", () => {
    expect(patchData).toEqual({});
    expect(customModelsData).toEqual([]);
  });
});

describe("repairToolCallIndices (Coral streaming index bug)", () => {
  const delta = (toolCalls: any) => ({ choices: [{ index: 0, delta: { tool_calls: toolCalls } }] });

  it("rewrites id-less fragments that claim a new index onto the last real call", () => {
    const seen = new Map<number, number>();
    // gpt-oss-120b on Coral: start + continuations at index 0, then the final
    // fragment arrives mis-indexed at 1.
    expect(repairToolCallIndices(delta([
      { id: "call_1", type: "function", index: 0, function: { name: "get_weather", arguments: "" } },
    ]), seen)).toBe(false);
    expect(repairToolCallIndices(delta([{ index: 0, function: { arguments: '{\"location\": \"Paris' } }]), seen)).toBe(false);
    expect(repairToolCallIndices(delta([{ index: 1, function: { arguments: '\"}' } }]), seen)).toBe(true);
  });

  it("leaves correct streams untouched (GLM null-id continuations at index 0)", () => {
    const seen = new Map<number, number>();
    const chunks = [
      [{ id: "call_1", index: 0, type: "function", function: { name: "get_weather", arguments: "" } }],
      [{ id: null, index: 0, type: "function", function: { name: null, arguments: "{" } }],
      [{ id: null, index: 0, type: "function", function: { name: null, arguments: '\"location\": \"Paris\"' } }],
      [{ id: null, index: 0, type: "function", function: { name: null, arguments: "}" } }],
    ];
    for (const tcs of chunks) {
      expect(repairToolCallIndices(delta(tcs), seen)).toBe(false);
    }
  });

  it("tracks parallel calls independently by their own ids", () => {
    const seen = new Map<number, number>();
    expect(repairToolCallIndices(delta([
      { id: "call_a", index: 0, type: "function", function: { name: "get_weather", arguments: "" } },
      { id: "call_b", index: 1, type: "function", function: { name: "get_weather", arguments: "" } },
    ]), seen)).toBe(false);
    // continuation of call_b mis-indexed at 2 → rewritten to 1
    expect(repairToolCallIndices(delta([{ index: 2, function: { arguments: "}" } }]), seen)).toBe(true);
  });

  it("ignores chunks without tool_calls or choices", () => {
    const seen = new Map<number, number>();
    expect(repairToolCallIndices({ choices: [] }, seen)).toBe(false);
    expect(repairToolCallIndices({}, seen)).toBe(false);
    expect(repairToolCallIndices(null, seen)).toBe(false);
  });
});
