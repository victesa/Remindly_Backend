import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { ingestRequestSchema, ingestResponseSchema } from "../contracts/ingest.js";
import { authPreHandler } from "../plugins/auth.js";
import type { AuthService } from "../ports/auth-service.js";
import type { IngestPipeline } from "../services/pipeline/ingest-pipeline.js";

function toOptionalString(input: unknown): string | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return undefined;
}

function parseMetadata(input: unknown): Record<string, unknown> | undefined {
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

type MultipartCapableRequest = FastifyRequest & {
  isMultipart: () => boolean;
  parts: () => AsyncIterable<MultipartFile | { type: "field"; fieldname: string; value: string }>;
};

function isMultipartRequest(request: FastifyRequest): boolean {
  const maybeMultipart = request as Partial<MultipartCapableRequest>;
  if (typeof maybeMultipart.isMultipart !== "function") {
    return false;
  }

  return maybeMultipart.isMultipart();
}

async function normalizeRequestBody(request: FastifyRequest) {
  const multipartRequest = request as MultipartCapableRequest;

  if (!isMultipartRequest(request)) {
    return ingestRequestSchema.parse(request.body);
  }

  let media: {
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
    size: number;
  } | undefined;

  const fields: Record<string, unknown> = {};

  for await (const part of multipartRequest.parts()) {
    if (part.type === "file") {
      const filePart = part as MultipartFile;
      if (filePart.fieldname !== "media") {
        continue;
      }

      const buffer = await filePart.toBuffer();
      media = {
        buffer,
        mimeType: filePart.mimetype,
        fileName: filePart.filename,
        size: buffer.length
      };
      continue;
    }

    fields[part.fieldname] = part.value;
  }

  return ingestRequestSchema.parse({
    itemId: toOptionalString(fields.itemId),
    contentType: toOptionalString(fields.contentType),
    extractedText: toOptionalString(fields.extractedText),
    mimeType: toOptionalString(fields.mimeType),
    capturedAt: toOptionalString(fields.capturedAt),
    metadata: parseMetadata(fields.metadata),
    media
  });
}

export async function registerIngestRoute(app: FastifyInstance, deps: { authService: AuthService; pipeline: IngestPipeline }): Promise<void> {
  app.post(
    "/v1/items/ingest",
    {
      preHandler: authPreHandler(deps.authService),
      attachValidation: true,
      schema: {
        tags: ["Items"],
        security: [{ bearerAuth: [] }],
        consumes: ["application/json", "multipart/form-data"],
        body: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Client-generated local item id" },
            contentType: {
              type: "string",
              enum: ["IMAGE", "DOCUMENT", "TEXT", "AUDIO", "VIDEO", "OTHER"]
            },
            media: { type: "string", format: "binary", description: "Optional uploaded file for multipart requests" },
            extractedText: { type: "string", description: "Optional OCR or raw text" },
            mimeType: { type: "string" },
            capturedAt: { type: "string", format: "date-time" },
            metadata: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    source: { type: "string", description: "Source label or http(s) URL to fetch content from" },
                    locale: { type: "string" },
                    timezone: { type: "string" },
                    extra: {
                      type: "object",
                      additionalProperties: true,
                      description: "Optional URL keys: url, link, sourceUrl, website"
                    }
                  },
                  additionalProperties: false
                },
                { type: "string", description: "For multipart, send metadata as a JSON string" }
              ]
            }
          },
          additionalProperties: true
        },
        response: {
          401: {
            type: "object",
            properties: {
              error: { type: "string" }
            },
            required: ["error"]
          },
          500: {
            type: "object",
            properties: {
              error: { type: "string" },
              message: { type: "string" }
            },
            required: ["error"]
          },
          200: {
            type: "object",
            properties: {
              item: { type: "object", additionalProperties: true },
              extraction: {
                type: "object",
                properties: {
                  strategy: { type: "string", enum: ["OCR_PLUS_SUMMARY", "VISION_FULL_EXTRACTION", "TEXT_FULL_EXTRACTION"] },
                  confidence: { type: "number" },
                  ocrQualityScore: { type: "number" }
                },
                required: ["strategy", "confidence", "ocrQualityScore"]
              }
            },
            required: ["item", "extraction"]
          }
        }
      }
    },
    async (request, reply) => {
      const multipartRequest = request as MultipartCapableRequest;
      const startedAt = Date.now();
      const requestIsMultipart = isMultipartRequest(request);

      request.log.info(
        {
          isMultipart: requestIsMultipart,
          contentType: request.headers["content-type"]
        },
        "ingest.request.start"
      );

      if (request.validationError && !requestIsMultipart) {
        throw request.validationError;
      }

      if (request.validationError && requestIsMultipart) {
        request.log.debug(
          {
            validationError: request.validationError.message
          },
          "Ignoring route body schema validation for multipart request"
        );
      }

      request.log.info("ingest.normalize.start");
      const body = await normalizeRequestBody(request);
      request.log.info({ ms: Date.now() - startedAt }, "ingest.normalize.success");
      const uid = request.authUser?.uid;

      if (!uid) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      request.log.info({ uid, itemId: body.itemId, contentType: body.contentType }, "ingest.pipeline.start");
      const result = await deps.pipeline.run(uid, body);
      request.log.info({ ms: Date.now() - startedAt }, "ingest.pipeline.success");
      const response = ingestResponseSchema.parse(result);
      request.log.info({ ms: Date.now() - startedAt }, "ingest.response.ready");
      return reply.code(200).send(response);
    }
  );
}
