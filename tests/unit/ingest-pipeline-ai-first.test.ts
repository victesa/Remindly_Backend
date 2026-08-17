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

describe("IngestPipeline AI-first extraction", () => {
  it("uses full text extraction instead of heuristic summary when OCR text is available", async () => {
    const geminiAi: GeminiAi = {
      evaluateOcrQuality: vi.fn(async () => ({ score: 0.9, isGoodEnough: true, canExtractFromText: true })),
      summarizeFromText: vi.fn(async () => ({ summary: "unused" })),
      extractRawTextFromImage: vi.fn(async () => ({ text: "", confidence: 0 })),
      extractFromVision: vi.fn(async () => {
        throw new Error("vision should not be called when text extraction succeeds");
      }),
      extractFromText: vi.fn(async () => ({
        extracted: {
          title: "St Mary Hospital Nurse Job Advert",
          summary: "Hospital hiring notice for nursing officers; apply before the listed deadline.",
          category: "JOB",
          deadline: "2026-09-10",
          eventDate: null,
          state: "READY",
          metadata: {
            company: "St Mary Hospital",
            position: "Nursing Officer"
          }
        },
        confidence: 0.9,
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
      uploadAndCreateReadUrl: vi.fn(async () => ({
        objectKey: "items/u1/i1/file.png",
        readUrl: "https://example.com/file.png"
      }))
    };

    const ocrClient: OcrClient = {
      extractFromImage: vi.fn(async () => ({
        text: "St Mary Hospital is hiring nursing officers. Apply before 2026-09-10.",
        confidence: 0.92
      }))
    };

    const pipeline = new IngestPipeline(config, geminiAi, itemRepository, mediaStorage, ocrClient, new TextExtractor());

    const result = await pipeline.run("user-1", {
      itemId: "item-1",
      contentType: "IMAGE",
      media: {
        buffer: Buffer.from("fake-image"),
        mimeType: "image/png",
        fileName: "image.png",
        size: 10
      }
    });

    expect(result.extraction.strategy).toBe("TEXT_FULL_EXTRACTION");
    expect(result.item.category).toBe("JOB");

    const extractFromTextMock = geminiAi.extractFromText as ReturnType<typeof vi.fn>;
    const summarizeFromTextMock = geminiAi.summarizeFromText as ReturnType<typeof vi.fn>;

    expect(extractFromTextMock).toHaveBeenCalledTimes(1);
    expect(summarizeFromTextMock).not.toHaveBeenCalled();
  });
});
