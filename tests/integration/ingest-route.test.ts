import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config/env.js";
import { buildApp } from "../../src/app.js";
import type { AuthService } from "../../src/ports/auth-service.js";
import type { IngestPipeline } from "../../src/services/pipeline/ingest-pipeline.js";

const config: AppConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 8080,
  LLM_PROVIDER: "gemini",
  GEMINI_API_KEY: "test",
  GEMINI_BASIC_MODEL: "gemini-2.5-flash",
  GEMINI_ADVANCED_MODEL: "gemini-2.5-pro",
  OPENROUTER_API_KEY: "",
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
  DEFAULT_TIMEZONE: "Africa/Nairobi",
  FIREBASE_PROJECT_ID: "demo",
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    projectId: "demo",
    clientEmail: "x@y.com",
    privateKey: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n"
  }),
  CLOUDFLARE_R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  CLOUDFLARE_R2_ACCESS_KEY_ID: "test-key",
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: "test-secret",
  CLOUDFLARE_R2_BUCKET: "remindly-media",
  CLOUDFLARE_R2_SIGNED_URL_TTL_SECONDS: 900
};

describe("POST /v1/items/ingest", () => {
  const authService: AuthService = {
    verifyBearerToken: async (token: string) => {
      if (token !== "valid") {
        throw new Error("invalid token");
      }
      return { uid: "user-1" };
    }
  };

  const pipeline: IngestPipeline = {
    run: async () => ({
      item: {
        id: "item-1",
        title: "Mock Item",
        summary: "Mock Summary",
        category: "EVENT",
        deadline: null,
        eventDate: null,
        state: "READY",
        metadata: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      extraction: {
        strategy: "VISION_FULL_EXTRACTION",
        confidence: 0.77,
        ocrQualityScore: 0.22
      }
    })
  } as IngestPipeline;

  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp(config, { authService, pipeline });
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("returns 401 when token is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/items/ingest",
      payload: {
        itemId: "local-generated-uuid",
        contentType: "TEXT",
        extractedText: "Only text payload",
        metadata: {}
      }
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns item on valid token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/items/ingest",
      headers: {
        authorization: "Bearer valid"
      },
      payload: {
        itemId: "local-generated-uuid",
        contentType: "TEXT",
        extractedText: "Sample OCR",
        capturedAt: "2026-07-28T10:30:00.000Z",
        metadata: {
          source: "mobile"
        }
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.item.id).toBe("item-1");
    expect(body.extraction.strategy).toBe("VISION_FULL_EXTRACTION");
  });
});
