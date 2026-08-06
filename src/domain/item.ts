import { z } from "zod";

export const ITEM_CATEGORIES = [
  "JOB",
  "EVENT",
  "SCHOLARSHIP",
  "MEETING",
  "EXAM",
  "ASSIGNMENT",
  "BILL",
  "PAYMENT",
  "APPOINTMENT",
  "SUBSCRIPTION",
  "TRAVEL",
  "HEALTH",
  "SHOPPING",
  "DOCUMENT",
  "PERSONAL",
  "OTHER"
] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export const CATEGORY_METADATA_KEYS: Record<ItemCategory, readonly string[]> = {
  JOB: ["company", "position", "location", "website", "contactEmail", "contactPhone", "salary"],
  EVENT: ["venue", "organiser", "website", "contactEmail", "contactPhone", "registrationLink"],
  SCHOLARSHIP: ["institution", "website", "contactEmail", "eligibility", "fundingAmount", "applicationLink"],
  MEETING: ["location", "organiser", "attendees", "meetingLink"],
  EXAM: ["venue", "subject", "candidateNumber"],
  ASSIGNMENT: ["course", "lecturer", "submissionLink"],
  BILL: ["provider", "accountNumber", "amount", "paymentLink"],
  PAYMENT: ["recipient", "amount", "paymentMethod", "reference"],
  APPOINTMENT: ["location", "contactName", "contactPhone"],
  SUBSCRIPTION: ["provider", "amount", "renewalPeriod", "website"],
  TRAVEL: [
    "destination",
    "departureLocation",
    "arrivalLocation",
    "departureTime",
    "bookingReference",
    "airline",
    "transportType"
  ],
  HEALTH: ["hospital", "doctor", "location", "contactPhone"],
  SHOPPING: ["store", "totalAmount", "shoppingList"],
  DOCUMENT: ["issuer", "documentType", "referenceNumber"],
  PERSONAL: ["notes"],
  OTHER: ["custom"]
};

export const ITEM_STATES = ["READY", "PROCESSING", "FAILED"] as const;
export type ItemState = (typeof ITEM_STATES)[number];

const metadataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.record(z.string(), z.unknown())
]);

export type MetadataValue = z.infer<typeof metadataValueSchema>;
export type ItemMetadata = Record<string, MetadataValue>;

export const itemAuditSchema = z.object({
  idempotencyKey: z.string().min(1),
  source: z.object({
    itemId: z.string().min(1),
    contentType: z.string().min(1),
    storagePath: z.string().min(1).nullable(),
    imageUrl: z.string().url().nullable(),
    mimeType: z.string().min(1).nullable(),
    sourceUrl: z.string().url().nullable().optional(),
    sourceContentFetched: z.boolean().optional(),
    capturedAt: z.string().datetime().nullable(),
    receivedAt: z.string().datetime(),
    extractedTextProvided: z.boolean()
  }),
  extraction: z.object({
    strategy: z.enum(["OCR_PLUS_SUMMARY", "VISION_FULL_EXTRACTION", "TEXT_FULL_EXTRACTION"]),
    confidence: z.number().min(0).max(1),
    ocrQualityScore: z.number().min(0).max(1),
    effectiveTimezone: z.string().min(1),
    model: z.string().min(1),
    usedAdvancedModel: z.boolean()
  })
});

export type ItemAudit = z.infer<typeof itemAuditSchema>;

export const itemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  category: z.enum(ITEM_CATEGORIES),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  state: z.enum(ITEM_STATES),
  metadata: z.record(z.string(), metadataValueSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export type Item = z.infer<typeof itemSchema>;

function cleanStringValue(value: string): string {
  return value.trim();
}

function cleanWebsiteValue(value: string): string {
  return value.trim().replace(/[.,;:!?)]*$/g, "");
}

function isMetadataValue(value: unknown): value is MetadataValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "string");
  }

  if (typeof value === "object" && value !== null) {
    return true;
  }

  return false;
}

export function sanitizeMetadata(category: ItemCategory, metadata: Record<string, unknown>): ItemMetadata {
  const allowedKeys = CATEGORY_METADATA_KEYS[category];
  if (category === "OTHER") {
    const custom: Record<string, unknown> =
      typeof metadata.custom === "object" && metadata.custom !== null
        ? (metadata.custom as Record<string, unknown>)
        : {};
    return { custom };
  }

  const result: ItemMetadata = {};
  const websiteLikeKeys = new Set(["website", "registrationLink", "applicationLink", "submissionLink", "paymentLink", "meetingLink"]);

  for (const key of allowedKeys) {
    const value = metadata[key];
    if (value !== undefined && value !== null && value !== "" && isMetadataValue(value)) {
      if (typeof value === "string") {
        result[key] = websiteLikeKeys.has(key) ? cleanWebsiteValue(value) : cleanStringValue(value);
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}
