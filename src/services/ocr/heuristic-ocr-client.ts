import type { OcrClient, OcrFallbackResult } from "../../ports/ocr-client.js";
import type { GeminiAi } from "../../ports/gemini-ai.js";

export class HeuristicOcrClient implements OcrClient {
  constructor(private readonly geminiAi: GeminiAi) {}

  async extractFromImage(imageUrl: string): Promise<OcrFallbackResult> {
    if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
      throw new Error("imageUrl must be a public http(s) URL for OCR fallback");
    }

    const extracted = await this.geminiAi.extractRawTextFromImage(imageUrl);

    return {
      text: extracted.text,
      confidence: extracted.confidence
    };
  }
}
