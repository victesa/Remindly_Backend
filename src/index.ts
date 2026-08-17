import { Buffer } from "node:buffer";
import { ZodError } from "zod";
import { loadConfig } from "./config/env.js";
import { ingestRequestSchema, ingestResponseSchema } from "./contracts/ingest.js";
import type { IngestRequest } from "./contracts/ingest.js";
import { FirestoreItemRepository } from "./repositories/firestore-item-repository.js";
import { FirebaseAuthService } from "./services/auth/firebase-auth-service.js";
import { TextExtractor } from "./services/extraction/text-extractor.js";
import { buildGeminiAi } from "./services/gemini/build-gemini-ai.js";
import { CloudflareR2MediaStorage } from "./services/media/cloudflare-r2-media-storage.js";
import { HeuristicOcrClient } from "./services/ocr/heuristic-ocr-client.js";
import { IngestPipeline } from "./services/pipeline/ingest-pipeline.js";

type WorkerContainer = {
  authService: FirebaseAuthService;
  pipeline: IngestPipeline;
};

let containerPromise: Promise<WorkerContainer> | null = null;

function buildContainer(runtimeEnv?: Record<string, unknown>): Promise<WorkerContainer> {
  if (!containerPromise) {
    const config = loadConfig(runtimeEnv);
    const geminiAi = buildGeminiAi(config);
    const itemRepository = new FirestoreItemRepository(config);
    const mediaStorage = new CloudflareR2MediaStorage(config);
    const ocrClient = new HeuristicOcrClient(geminiAi);
    const textExtractor = new TextExtractor();
    const pipeline = new IngestPipeline(config, geminiAi, itemRepository, mediaStorage, ocrClient, textExtractor);
    const authService = new FirebaseAuthService(config);

    containerPromise = Promise.resolve({ authService, pipeline });
  }

  return containerPromise;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function toOptionalString(input: FormDataEntryValue | null): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseMetadataField(input: FormDataEntryValue | null): Record<string, unknown> | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function parseIngestRequest(request: Request): Promise<IngestRequest> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const mediaField = formData.get("media");

      let media: IngestRequest["media"];
      if (mediaField instanceof File) {
        const buffer = Buffer.from(await mediaField.arrayBuffer());
        media = {
          buffer,
          mimeType: mediaField.type || "application/octet-stream",
          ...(mediaField.name ? { fileName: mediaField.name } : {}),
          size: buffer.length
        };
      }

      return ingestRequestSchema.parse({
        itemId: toOptionalString(formData.get("itemId")),
        contentType: toOptionalString(formData.get("contentType")),
        extractedText: toOptionalString(formData.get("extractedText")),
        mimeType: toOptionalString(formData.get("mimeType")),
        capturedAt: toOptionalString(formData.get("capturedAt")),
        metadata: parseMetadataField(formData.get("metadata")),
        ...(media ? { media } : {})
      });
    }

    const parsedJson = (await request.json()) as unknown;
    return ingestRequestSchema.parse(parsedJson);
  } catch (error) {
    if (error instanceof ZodError) {
      throw error;
    }

    throw Object.assign(new Error("Invalid request body"), { statusCode: 400 });
  }
}

async function authenticateUser(authorization: string | null, authService: FirebaseAuthService): Promise<string> {
  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  try {
    const user = await authService.verifyBearerToken(token);
    return user.uid;
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "unknown";
    if (code === "auth/id-token-expired") {
      throw Object.assign(new Error("Firebase ID token expired. Refresh token on client and retry."), {
        statusCode: 401,
        code: "TOKEN_EXPIRED"
      });
    }

    if (code === "auth/timeout") {
      throw Object.assign(new Error("Authentication provider timeout"), { statusCode: 503 });
    }

    if (code === "auth/configuration-error") {
      throw Object.assign(new Error("Authentication provider configuration error"), { statusCode: 500 });
    }

    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof ZodError) {
    return jsonResponse(400, {
      error: "Bad Request",
      details: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
  }

  const statusCode =
    typeof (error as { statusCode?: unknown }).statusCode === "number" && (error as { statusCode: number }).statusCode >= 400
      ? (error as { statusCode: number }).statusCode
      : 500;

  const message = error instanceof Error ? error.message : "Unknown error";

  if (statusCode === 401 && typeof (error as { code?: unknown }).code === "string") {
    return jsonResponse(401, {
      error: "Unauthorized",
      code: (error as { code: string }).code,
      message
    });
  }

  if (statusCode === 401) {
    return jsonResponse(401, { error: "Unauthorized" });
  }

  if (statusCode === 503) {
    return jsonResponse(503, { error: "Service Unavailable", message });
  }

  if (statusCode === 429) {
    return new Response(JSON.stringify({ error: "Too Many Requests", message }), {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "retry-after": "60"
      }
    });
  }

  if (statusCode >= 400 && statusCode < 500) {
    return jsonResponse(statusCode, { error: "Request Failed", message });
  }

  return jsonResponse(500, { error: "Internal Server Error", message });
}

async function handleRequest(request: Request, env: Record<string, unknown>): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse(200, { ok: true });
  }

  if (request.method === "POST" && url.pathname === "/v1/items/ingest") {
    const { authService, pipeline } = await buildContainer(env);
    const uid = await authenticateUser(request.headers.get("authorization"), authService);
    const ingestRequest = await parseIngestRequest(request);
    const result = await pipeline.run(uid, ingestRequest);
    const responseBody = ingestResponseSchema.parse(result);
    return jsonResponse(200, responseBody);
  }

  return jsonResponse(404, { error: "Not Found" });
}

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("worker.request.error", error);
      return errorResponse(error);
    }
  }
};
