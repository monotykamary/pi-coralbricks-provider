import { describe, expect, it } from "vitest";
import {
  activeDeprecatedModels,
  applyPatch,
  buildModels,
  mergeWithEmbedded,
  parseContextWindow,
  transformApiModel,
  transformCatalogModel,
  withDeprecated,
} from "../index";
import modelsData from "../models.json" with { type: "json" };
import customModelsData from "../custom-models.json" with { type: "json" };
import patchData from "../patch.json" with { type: "json" };
import deprecatedData from "../deprecated-models.json" with { type: "json" };

const DEPRECATED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// A Coral /v1/models row shaped as the gateway returns it (2026-09-22, less the
// rolling speed/latency/cache-hit stats, which the transform ignores).
const v1DeepSeekRow = {
  id: "deepseek-v4.1-flash-fast-fp4",
  object: "model",
  owned_by: "coralbricks",
  context_length: 1048576,
  created: 1789000000,
  pricing: { cache_write_multiple: 0.3, cache_write_per_m: 0.09, cached_input_per_m: 0, input_per_m: 0.3, output_per_m: 1.2 },
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
    const m = transformApiModel(v1DeepSeekRow)!;
    expect(m.id).toBe("deepseek-v4.1-flash-fast-fp4");
    expect(m.input).toEqual(["text", "image"]);
    expect(m.cost).toEqual({ input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0.09 });
    expect(m.contextWindow).toBe(1048576);
    expect(m.compat?.supportsStore).toBe(false);
    expect(m.compat?.supportsDeveloperRole).toBe(false);
    expect(m.compat?.maxTokensField).toBe("max_tokens");
  });

  it("keeps Coral's free cached reads at cacheRead: 0", () => {
    const m = transformApiModel(v1DeepSeekRow)!;
    expect(m.cost.cacheRead).toBe(0);
  });

  it("bills cache writes at cache_write_per_m, and 0 when a row omits it", () => {
    expect(transformApiModel(v1DeepSeekRow)!.cost.cacheWrite).toBe(0.09);
    const { cache_write_per_m: _omitted, ...pricing } = v1DeepSeekRow.pricing;
    expect(transformApiModel({ ...v1DeepSeekRow, pricing })!.cost.cacheWrite).toBe(0);
  });

  it("defaults new models to text-only and falls back for maxTokens", () => {
    const text = transformApiModel({ id: "some-text-model", context_length: 131072, pricing: {} })!;
    expect(text.input).toEqual(["text"]);
    expect(text.maxTokens).toBe(32768);

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
    const live = transformApiModel({
      ...v1DeepSeekRow,
      id: "glm-5.3-fp4",
      supports_image_input: false,
      pricing: { cache_write_per_m: 2, cached_input_per_m: 0, input_per_m: 5, output_per_m: 20 },
    })!;
    const merged = mergeWithEmbedded([live], modelsData as any);
    const glm = merged.find((m) => m.id === "glm-5.3-fp4")!;
    expect(glm.cost).toEqual({ input: 5, output: 20, cacheRead: 0, cacheWrite: 2 });
    expect(glm.compat?.thinkingFormat).toBe("zai");
    expect(glm.thinkingLevelMap).toBeDefined();
    expect(glm.input).toEqual(["text"]);
  });

  it("keeps the embedded cache-write rate when the public catalog (no such field) is the live source", () => {
    const live = transformCatalogModel(catalogGlmRow)!;
    expect(live.cost.cacheWrite).toBe(0);
    const merged = mergeWithEmbedded([live], modelsData as any);
    expect(merged.find((m) => m.id === "glm-5.3-fp4")!.cost.cacheWrite).toBe(1.68);
  });

  it("appends embedded-only models (delisted from live)", () => {
    const live = [transformApiModel({ id: "brand-new-model", pricing: { input_per_m: 1, output_per_m: 2 } })!];
    const merged = mergeWithEmbedded(live, modelsData as any);
    expect(merged.some((m) => m.id === "glm-5.3-fp4")).toBe(true);
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
    expect(models.map((m) => m.id).sort()).toEqual(["deepseek-v4.1-flash-fast-fp4", "glm-5.3-flash-fp4", "glm-5.3-fp4"]);
    // Deprecated entries live only for the updater's 14-day grace window
    // (evicted once now - deprecatedAt exceeds DEPRECATED_TTL_MS), so assert
    // the separation contract rather than a pinned id.
    expect(deprecatedModels.filter((m) => models.some((active) => active.id === m.id))).toEqual([]);
    expect(new Set(deprecatedModels.map((m) => m.id)).size).toBe(deprecatedModels.length);
    for (const m of deprecatedModels) {
      expect(Number.isNaN(Date.parse(m.deprecatedAt ?? ""))).toBe(false);
    }
  });

  it("has well-formed costs with free cached reads and a cache-write rate", () => {
    for (const m of models) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        expect(typeof m.cost[key]).toBe("number");
      }
      expect(m.cost.cacheRead).toBe(0); // Coral: cached input is free
      expect(m.cost.cacheWrite).toBeGreaterThan(0); // Coral bills uncached prompt tokens as cache writes
      expect(m.contextWindow).toBeGreaterThanOrEqual(131072);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
  });

  it("keeps pricing aligned with Coral's published rates", () => {
    const byId = Object.fromEntries(catalog.map((m) => [m.id, m]));
    // glm-5.2-fp4 is delisted; it is present only during its grace window.
    const glm52 = byId["glm-5.2-fp4"];
    if (glm52) expect(glm52.cost).toMatchObject({ input: 1.12, output: 4.4 });
    // https://www.coralbricks.ai/pricing, 2026-09-22
    expect(byId["glm-5.3-fp4"].cost).toMatchObject({ input: 1.12, output: 4.4, cacheWrite: 1.68 });
    expect(byId["glm-5.3-flash-fp4"].cost).toMatchObject({ input: 0.15, output: 0.5, cacheWrite: 0.23 });
    expect(byId["deepseek-v4.1-flash-fast-fp4"].cost).toMatchObject({ input: 0.3, output: 1.2, cacheWrite: 0.09 });
  });

  it("gives every effective model reasoning config after patch.json", () => {
    const effective = buildModels(modelsData as any, customModelsData as any, patchData as any);
    for (const m of effective) {
      expect(m.reasoning).toBe(true);
      expect(m.thinkingLevelMap).toBeDefined();
      expect(m.compat?.thinkingFormat).toBeDefined();
      expect(m.compat?.supportsStore).toBe(false);
      expect(m.compat?.supportsDeveloperRole).toBe(false);
    }
  });

  it("maps thinking levels per upstream model family", () => {
    // GLM 5.2 is delisted and embedded only during its grace window, so inject
    // its last-known definition to keep the family mapping covered permanently.
    const glm52Fixture = {
      id: "glm-5.2-fp4",
      name: "GLM 5.2 FP4",
      reasoning: true,
      input: ["text"],
      cost: { input: 1.12, output: 4.4, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1048576,
      maxTokens: 131072,
      thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
        thinkingFormat: "zai",
      },
    };
    const effective = buildModels([...modelsData, glm52Fixture] as any, customModelsData as any, patchData as any);
    const byId = Object.fromEntries(effective.map((m) => [m.id, m]));
    // GLM 5.2: zai format, off→disabled + high/max efforts
    expect(byId["glm-5.2-fp4"].compat?.thinkingFormat).toBe("zai");
    expect(byId["glm-5.2-fp4"].thinkingLevelMap).toMatchObject({ off: "none", high: "high", max: "max" });
    // GLM 5.3 adds a low effort
    expect(byId["glm-5.3-fp4"].thinkingLevelMap).toMatchObject({ off: "none", low: "low", high: "high", max: "max" });
    // GLM 5.3 Flash: same zai family map; only low/high/max efforts exist upstream
    expect(byId["glm-5.3-flash-fp4"].compat?.thinkingFormat).toBe("zai");
    expect(byId["glm-5.3-flash-fp4"].thinkingLevelMap).toMatchObject({ off: "none", low: "low", high: "high", max: "max" });
    expect(byId["glm-5.3-flash-fp4"].maxTokens).toBe(131072);
    expect(byId["glm-5.3-flash-fp4"].input).toEqual(["text", "image"]);
    // DeepSeek V4.1 Flash: openai reasoning_effort; reasoning is opt-in, so off sends none
    expect(byId["deepseek-v4.1-flash-fast-fp4"].compat?.thinkingFormat).toBe("openai");
    expect(byId["deepseek-v4.1-flash-fast-fp4"].compat?.supportsReasoningEffort).toBe(true);
    expect(byId["deepseek-v4.1-flash-fast-fp4"].thinkingLevelMap).toMatchObject({ off: "none", low: "low", medium: null, high: "high", max: "max" });
  });

  it("flags vision from the live API flag", () => {
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["deepseek-v4.1-flash-fast-fp4"].input).toContain("image");
    expect(byId["glm-5.3-flash-fp4"].input).toContain("image");
    expect(byId["glm-5.3-fp4"].input).toEqual(["text"]);
  });

  it("curates DeepSeek V4.1 Flash and GLM 5.3 Flash via patch.json; custom models stay empty", () => {
    expect(Object.keys(patchData)).toEqual(["deepseek-v4.1-flash-fast-fp4", "glm-5.3-flash-fp4"]);
    expect(customModelsData).toEqual([]);
  });
});

