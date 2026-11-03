import { describe, expect, it, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("/v1/models compatible provider context window", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("respects caps.contextWindow on customModels over generic pattern matching", async () => {
    db.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        provider: "openai-compatible-chat-1",
        isActive: true,
        providerSpecificData: {
          prefix: "lc",
          baseUrl: "http://127.0.0.1:58100/v1",
        },
      },
    ]);
    db.getCustomModels.mockResolvedValue([
      {
        providerAlias: "openai-compatible-chat-1",
        id: "gemini-flash",
        type: "llm",
        name: "gemini-flash",
        caps: {
          contextWindow: 185000,
          maxOutput: 8192,
        },
      },
    ]);

    // Skip dynamic fetch during test to isolate customModelCaps lookup
    const models = await buildModelsList(["llm"], { skipDynamicFetch: true });
    const gemini = models.find((m) => m.id === "lc/gemini-flash");

    expect(gemini).toBeDefined();
    expect(gemini.context_length).toBe(185000);
    expect(gemini.max_completion_tokens).toBe(8192);
    expect(gemini.capabilities.contextWindow).toBe(185000);
  });

  it("adopts context_length and max_tokens from dynamic /models fetch for compatible providers", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        object: "list",
        data: [
          {
            id: "gemini-flash",
            context_length: 185000,
            max_tokens: 8192,
          },
        ],
      }),
    });
    global.fetch = fakeFetch;

    db.getProviderConnections.mockResolvedValue([
      {
        id: "conn-2",
        provider: "openai-compatible-chat-2",
        apiKey: "test-key-abc",
        isActive: true,
        providerSpecificData: {
          prefix: "router",
          baseUrl: "http://127.0.0.1:58100/v1",
        },
      },
    ]);
    db.getCustomModels.mockResolvedValue([]);

    const models = await buildModelsList(["llm"]);
    const gemini = models.find((m) => m.id === "router/gemini-flash");

    expect(gemini).toBeDefined();
    expect(gemini.context_length).toBe(185000);
    expect(gemini.max_completion_tokens).toBe(8192);
    expect(gemini.capabilities.contextWindow).toBe(185000);
  });
});
