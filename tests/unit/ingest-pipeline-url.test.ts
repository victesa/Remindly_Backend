import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config/env.js";
import { IngestPipeline } from "../../src/services/pipeline/ingest-pipeline.js";
import type { GeminiAi } from "../../src/ports/gemini-ai.js";
import type { ItemRepository } from "../../src/ports/item-repository.js";
import type { MediaStorage } from "../../src/ports/media-storage.js";
import type { OcrClient } from "../../src/ports/ocr-client.js";
import { TextExtractor } from "../../src/services/extraction/text-extractor.js";

const config: AppConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 8080,
  LLM_PROVIDER: "openrouter",
  GEMINI_API_KEY: "",
  GEMINI_BASIC_MODEL: "gemini-2.5-flash",
  GEMINI_ADVANCED_MODEL: "gemini-2.5-pro",
  OPENROUTER_API_KEY: "test-key",
  OPENROUTER_MODEL: "openai/gpt-4o-mini",
  OPENROUTER_ADVANCED_MODEL: "",
  OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
  LLM_ENABLE_PROVIDER_FAILOVER: false,
  LLM_LOW_COST_MODE: false,
  LLM_DISABLE_ADVANCED_FALLBACK: false,
  LLM_MAX_INFERENCE_TEXT_LENGTH: 12000,
  LLM_MAX_LLM_CALLS_PER_REQUEST: 4,
  LLM_DEDUPE_TTL_SECONDS: 300,
  OCR_MIN_SCORE: 0.45,
  DEFAULT_TIMEZONE: "UTC",
  FIREBASE_PROJECT_ID: "demo",
  FIREBASE_SERVICE_ACCOUNT_JSON: "{}",
  CLOUDFLARE_R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  CLOUDFLARE_R2_ACCESS_KEY_ID: "test-key",
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: "test-secret",
  CLOUDFLARE_R2_BUCKET: "remindly-media",
  CLOUDFLARE_R2_SIGNED_URL_TTL_SECONDS: 900
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IngestPipeline URL content extraction", () => {
  it("fetches source URL text when payload only contains a link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          "<html><body><h1>Scholarship 2026</h1><p>Deadline is 31 August 2026. Apply at https://example.org/apply</p></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          }
        )
      )
    );

    const geminiAi: GeminiAi = {
      evaluateOcrQuality: vi.fn(async () => ({ score: 0, isGoodEnough: false, canExtractFromText: false })),
      summarizeFromText: vi.fn(async () => ({ summary: "unused" })),
      extractRawTextFromImage: vi.fn(async () => ({ text: "", confidence: 0 })),
      extractFromVision: vi.fn(async () => {
        throw new Error("vision should not be called");
      }),
      extractFromText: vi.fn(async () => ({
        extracted: {
          title: "Scholarship 2026",
          summary: "Scholarship details",
          category: "SCHOLARSHIP",
          deadline: "2026-08-31",
          eventDate: null,
          state: "READY",
          metadata: { website: "https://example.org/apply" }
        },
        confidence: 0.86,
        usedAdvancedModel: false,
        model: "openai/gpt-4o-mini"
      }))
    };

    const itemRepository: ItemRepository = {
      save: vi.fn(async (input) => ({
        id: input.itemId,
        title: input.title,
        summary: input.summary,
        category: input.category,
        deadline: input.deadline,
        eventDate: input.eventDate,
        state: input.state,
        metadata: input.metadata,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }))
    };

    const mediaStorage: MediaStorage = {
      uploadAndCreateReadUrl: vi.fn(async () => {
        throw new Error("media should not be uploaded for link-only request");
      })
    };

    const ocrClient: OcrClient = {
      extractFromImage: vi.fn(async () => ({ text: "", confidence: 0 }))
    };

    const pipeline = new IngestPipeline(config, geminiAi, itemRepository, mediaStorage, ocrClient, new TextExtractor());

    const result = await pipeline.run("user-1", {
      itemId: "item-1",
      contentType: "TEXT",
      metadata: {
        source: "https://example.org/post"
      }
    });

    expect(result.item.title).toBe("Scholarship 2026");
    expect(result.extraction.strategy).toBe("TEXT_FULL_EXTRACTION");

    const extractFromTextMock = geminiAi.extractFromText as ReturnType<typeof vi.fn>;
    expect(extractFromTextMock).toHaveBeenCalledTimes(1);
    const calledWith = extractFromTextMock.mock.calls[0]?.[0];
    expect(calledWith.text).toContain("Source URL: https://example.org/post");
    expect(calledWith.text).toContain("Deadline is 31 August 2026");
  });
});
