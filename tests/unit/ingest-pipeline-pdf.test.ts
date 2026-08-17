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

describe("IngestPipeline PDF handling", () => {
  it("returns 400 for PDF uploads without extractedText or source URL", async () => {
    const geminiAi: GeminiAi = {
      evaluateOcrQuality: vi.fn(async () => ({ score: 0, isGoodEnough: false, canExtractFromText: false })),
      summarizeFromText: vi.fn(async () => ({ summary: "unused" })),
      extractRawTextFromImage: vi.fn(async () => ({ text: "", confidence: 0 })),
      extractFromVision: vi.fn(async () => {
        throw new Error("vision should not be called for PDF");
      }),
      extractFromText: vi.fn(async () => {
        throw new Error("text extraction should not be called without text");
      })
    };

    const itemRepository: ItemRepository = {
      save: vi.fn(async () => {
        throw new Error("save should not be called");
      })
    };

    const mediaStorage: MediaStorage = {
      uploadAndCreateReadUrl: vi.fn(async () => ({
        objectKey: "items/u1/i1/file.pdf",
        readUrl: "https://example.com/file.pdf"
      }))
    };

    const ocrClient: OcrClient = {
      extractFromImage: vi.fn(async () => ({ text: "", confidence: 0 }))
    };

    const pipeline = new IngestPipeline(config, geminiAi, itemRepository, mediaStorage, ocrClient, new TextExtractor());

    await expect(
      pipeline.run("user-1", {
        itemId: "item-1",
        contentType: "DOCUMENT",
        media: {
          buffer: Buffer.from("%PDF-1.4"),
          mimeType: "application/pdf",
          fileName: "file.pdf",
          size: 8
        }
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("Unsupported media format for vision extraction")
    });

    const visionMock = geminiAi.extractFromVision as ReturnType<typeof vi.fn>;
    expect(visionMock).not.toHaveBeenCalled();
  });
});
