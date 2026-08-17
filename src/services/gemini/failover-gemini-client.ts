import type { ExtractedItem } from "../../contracts/ingest.js";
import type { ItemState } from "../../domain/item.js";
import type { GeminiAi, OcrEvaluation, VisionExtractionResult } from "../../ports/gemini-ai.js";

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? "");
}

function shouldFailover(error: unknown): boolean {
  const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 0;
  if (statusCode === 402 || statusCode === 429) {
    return true;
  }

  const message = toMessage(error).toLowerCase();
  return (
    message.includes("quota") ||
    message.includes("credit") ||
    message.includes("billing") ||
    message.includes("insufficient") ||
    message.includes("payment required")
  );
}

export class FailoverGeminiClient implements GeminiAi {
  constructor(
    private readonly primary: GeminiAi,
    private readonly fallback: GeminiAi,
    private readonly primaryName: "gemini" | "openrouter",
    private readonly fallbackName: "gemini" | "openrouter"
  ) {}

  private async withFailover<T>(operation: string, execute: (client: GeminiAi) => Promise<T>): Promise<T> {
    try {
      return await execute(this.primary);
    } catch (error) {
      if (!shouldFailover(error)) {
        throw error;
      }

      try {
        return await execute(this.fallback);
      } catch (fallbackError) {
        const joined = new Error(
          `${operation} failed on primary ${this.primaryName} and fallback ${this.fallbackName}: ${toMessage(fallbackError)}`
        ) as Error & { cause?: unknown; statusCode?: number };
        joined.cause = fallbackError;
        joined.statusCode =
          typeof (fallbackError as { statusCode?: unknown }).statusCode === "number"
            ? (fallbackError as { statusCode: number }).statusCode
            : 503;
        throw joined;
      }
    }
  }

  async evaluateOcrQuality(input: { imageUrl: string; ocrText: string; minScore: number }): Promise<OcrEvaluation> {
    return this.withFailover("evaluateOcrQuality", (client) => client.evaluateOcrQuality(input));
  }

  async summarizeFromText(input: { text: string; title?: string; timezone: string }): Promise<{ summary: string; state?: ItemState }> {
    return this.withFailover("summarizeFromText", (client) => client.summarizeFromText(input));
  }

  async extractRawTextFromImage(imageUrl: string): Promise<{ text: string; confidence: number }> {
    return this.withFailover("extractRawTextFromImage", (client) => client.extractRawTextFromImage(imageUrl));
  }

  async extractFromText(input: {
    text: string;
    timezone: string;
    preferBasicModel: boolean;
  }): Promise<{ extracted: ExtractedItem; confidence: number; usedAdvancedModel: boolean; model: string }> {
    return this.withFailover("extractFromText", (client) => client.extractFromText(input));
  }

  async extractFromVision(input: {
    imageUrl: string;
    ocrText?: string;
    timezone: string;
    preferBasicModel: boolean;
  }): Promise<VisionExtractionResult> {
    return this.withFailover("extractFromVision", (client) => client.extractFromVision(input));
  }
}
