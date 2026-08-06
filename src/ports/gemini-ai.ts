import type { ExtractedItem } from "../contracts/ingest.js";
import type { ItemState } from "../domain/item.js";

export type OcrEvaluation = {
  score: number;
  isGoodEnough: boolean;
  canExtractFromText: boolean;
  correctedOcrText?: string;
};

export type VisionExtractionResult = {
  extracted: ExtractedItem;
  confidence: number;
  usedAdvancedModel: boolean;
  model: string;
};

export type TextExtractionResult = {
  extracted: ExtractedItem;
  confidence: number;
  usedAdvancedModel: boolean;
  model: string;
};

export interface GeminiAi {
  evaluateOcrQuality(input: { imageUrl: string; ocrText: string; minScore: number }): Promise<OcrEvaluation>;
  summarizeFromText(input: { text: string; title?: string; timezone: string }): Promise<{ summary: string; state?: ItemState }>;
  extractRawTextFromImage(imageUrl: string): Promise<{ text: string; confidence: number }>;
  extractFromText(input: { text: string; timezone: string; preferBasicModel: boolean }): Promise<TextExtractionResult>;
  extractFromVision(input: {
    imageUrl: string;
    ocrText?: string;
    timezone: string;
    preferBasicModel: boolean;
  }): Promise<VisionExtractionResult>;
}
