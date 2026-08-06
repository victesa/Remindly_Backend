import { z } from "zod";
import { ITEM_CATEGORIES, ITEM_STATES } from "../domain/item.js";

export const CONTENT_TYPES = ["IMAGE", "DOCUMENT", "TEXT", "AUDIO", "VIDEO", "OTHER"] as const;

export const ingestMediaSchema = z.object({
  buffer: z.instanceof(Buffer),
  mimeType: z.string().min(1),
  fileName: z.string().optional(),
  size: z.number().int().nonnegative()
});

export const ingestRequestSchema = z.object({
  itemId: z.string().min(1),
  contentType: z.enum(CONTENT_TYPES),
  media: ingestMediaSchema.optional(),
  extractedText: z.string().optional(),
  mimeType: z.string().optional(),
  capturedAt: z.string().datetime().optional(),
  metadata: z
    .object({
      source: z.string().optional(),
      locale: z.string().optional(),
      timezone: z.string().optional(),
      extra: z.record(z.string(), z.unknown()).optional()
    })
    .optional()
}).superRefine((input, ctx) => {
  const source = input.metadata?.source?.trim();
  const extra = input.metadata?.extra;
  const sourceUrlCandidates = [
    source,
    typeof extra?.url === "string" ? extra.url : undefined,
    typeof extra?.link === "string" ? extra.link : undefined,
    typeof extra?.sourceUrl === "string" ? extra.sourceUrl : undefined,
    typeof extra?.website === "string" ? extra.website : undefined
  ];

  const hasHttpSourceUrl = sourceUrlCandidates.some((candidate) => {
    if (!candidate) {
      return false;
    }

    try {
      const url = new URL(candidate.trim());
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  });

  if (!input.media && !input.extractedText && !hasHttpSourceUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide media, extractedText, or a source URL in metadata",
      path: ["media"]
    });
  }
});

export type IngestRequest = z.infer<typeof ingestRequestSchema>;

export const extractedItemSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  category: z.enum(ITEM_CATEGORIES),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  state: z.enum(ITEM_STATES).default("READY"),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type ExtractedItem = z.infer<typeof extractedItemSchema>;

export const ingestResponseSchema = z.object({
  item: z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    category: z.enum(ITEM_CATEGORIES),
    deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    state: z.enum(ITEM_STATES),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  }),
  extraction: z.object({
    strategy: z.enum(["OCR_PLUS_SUMMARY", "VISION_FULL_EXTRACTION", "TEXT_FULL_EXTRACTION"]),
    confidence: z.number().min(0).max(1),
    ocrQualityScore: z.number().min(0).max(1)
  })
});

export type IngestResponse = z.infer<typeof ingestResponseSchema>;
