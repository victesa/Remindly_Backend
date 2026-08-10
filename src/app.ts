import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import type { AppConfig } from "./config/env.js";
import openApiPlugin from "./plugins/openapi.js";
import type { AuthService } from "./ports/auth-service.js";
import type { GeminiAi } from "./ports/gemini-ai.js";
import type { ItemRepository } from "./ports/item-repository.js";
import type { MediaStorage } from "./ports/media-storage.js";
import type { OcrClient } from "./ports/ocr-client.js";
import { FirestoreItemRepository } from "./repositories/firestore-item-repository.js";
import { registerIngestRoute } from "./routes/ingest-route.js";
import { FirebaseAuthService } from "./services/auth/firebase-auth-service.js";
import { TextExtractor } from "./services/extraction/text-extractor.js";
import { GeminiHttpClient } from "./services/gemini/gemini-http-client.js";
import { OpenRouterClient } from "./services/gemini/openrouter-client.js";
import { CloudflareR2MediaStorage } from "./services/media/cloudflare-r2-media-storage.js";
import { IngestPipeline } from "./services/pipeline/ingest-pipeline.js";
import { HeuristicOcrClient } from "./services/ocr/heuristic-ocr-client.js";

export type AppDeps = {
  authService: AuthService;
  geminiAi: GeminiAi;
  itemRepository: ItemRepository;
  mediaStorage: MediaStorage;
  ocrClient: OcrClient;
  textExtractor: TextExtractor;
  pipeline: IngestPipeline;
};

function buildDeps(config: AppConfig, depsOverride?: Partial<AppDeps>): AppDeps {
  const geminiAi =
    depsOverride?.geminiAi ?? (config.LLM_PROVIDER === "openrouter" ? new OpenRouterClient(config) : new GeminiHttpClient(config));
  const itemRepository =
    depsOverride?.itemRepository ??
    (depsOverride?.pipeline
      ? {
          save: async () => {
            throw new Error("ItemRepository was not provided while pipeline override is active");
          }
        }
      : new FirestoreItemRepository(config));
  const mediaStorage = depsOverride?.mediaStorage ?? new CloudflareR2MediaStorage(config);
  const ocrClient = depsOverride?.ocrClient ?? new HeuristicOcrClient(geminiAi);
  const textExtractor = depsOverride?.textExtractor ?? new TextExtractor();
  const pipeline =
    depsOverride?.pipeline ?? new IngestPipeline(config, geminiAi, itemRepository, mediaStorage, ocrClient, textExtractor);
  const authService = depsOverride?.authService ?? new FirebaseAuthService(config);

  return {
    authService,
    geminiAi,
    itemRepository,
    mediaStorage,
    ocrClient,
    textExtractor,
    pipeline
  };
}

export async function buildApp(config: AppConfig, depsOverride?: Partial<AppDeps>): Promise<FastifyInstance> {
  const isCloudflareWorkersRuntime =
    typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined";

  const app = Fastify({
    logger: isCloudflareWorkersRuntime ? false : true
  });

  const deps = buildDeps(config, depsOverride);

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        statusCode: reply.statusCode,
        responseTimeMs: reply.elapsedTime
      },
      "http.response.sent"
    );
  });

  app.addHook("onRequestAbort", async (request) => {
    request.log.warn("http.request.aborted");
  });

  await app.register(openApiPlugin);
  await app.register(multipart, {
    limits: {
      fileSize: 15 * 1024 * 1024,
      files: 1
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Bad Request",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? ((error as { statusCode: number }).statusCode >= 400 && (error as { statusCode: number }).statusCode < 600
            ? (error as { statusCode: number }).statusCode
            : 500)
        : 500;

    app.log.error(error);

    if (statusCode === 503) {
      reply.header("Retry-After", "5");
    }

    if (config.NODE_ENV !== "production") {
      return reply.code(statusCode).send({
        error: statusCode === 503 ? "Service Unavailable" : statusCode === 500 ? "Internal Server Error" : "Request Failed",
        message
      });
    }

    return reply.code(statusCode).send({ error: "Internal Server Error" });
  });

  app.get("/health", async () => ({ ok: true }));
  await registerIngestRoute(app, {
    authService: deps.authService,
    pipeline: deps.pipeline
  });

  return app;
}
