import type { AppConfig } from "../../config/env.js";
import type { ExtractedItem } from "../../contracts/ingest.js";
import { extractedItemSchema } from "../../contracts/ingest.js";
import type { ItemState } from "../../domain/item.js";
import type { GeminiAi, OcrEvaluation, VisionExtractionResult } from "../../ports/gemini-ai.js";

type HttpError = Error & {
  statusCode?: number;
  code?: string;
  retryable?: boolean;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

function stripJsonMarkdown(text: string): string {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
}

function buildInlineDataPart(bytes: Buffer, mimeType: string): { inline_data: { mime_type: string; data: string } } {
  return {
    inline_data: {
      mime_type: mimeType,
      data: bytes.toString("base64")
    }
  };
}

async function fetchImageAsInlinePart(imageUrl: string): Promise<{ inline_data: { mime_type: string; data: string } }> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from URL for Gemini prompt: ${response.status}`);
  }

  const mimeType = response.headers.get("content-type") ?? "image/jpeg";
  const bytes = Buffer.from(await response.arrayBuffer());
  return buildInlineDataPart(bytes, mimeType);
}

export class GeminiHttpClient implements GeminiAi {
  constructor(private readonly config: AppConfig) {}

  private createHttpError(message: string, statusCode: number, retryable: boolean): HttpError {
    const error = new Error(message) as HttpError;
    error.statusCode = statusCode;
    error.code = "UPSTREAM_GEMINI_ERROR";
    error.retryable = retryable;
    return error;
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || status === 503 || (status >= 500 && status <= 599);
  }

  private async callGeminiOnce(options: {
    model: string;
    textPrompt: string;
    imageUrl?: string;
  }): Promise<string> {
    const parts: Array<Record<string, unknown>> = [{ text: options.textPrompt }];

    if (options.imageUrl) {
      parts.push(await fetchImageAsInlinePart(options.imageUrl));
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent?key=${this.config.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts
            }
          ]
        })
      }
    );

    if (!response.ok) {
      const body = await response.text();
      const retryable = this.isRetryableStatus(response.status);
      throw this.createHttpError(`Gemini request failed (${response.status}): ${body}`, response.status, retryable);
    }

    const json = (await response.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n").trim();

    if (!text) {
      throw this.createHttpError("Gemini returned empty content", 502, true);
    }

    return text;
  }

  private async generateWithRetries(options: {
    model: string;
    textPrompt: string;
    imageUrl?: string;
    maxAttempts: number;
  }): Promise<string> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < options.maxAttempts) {
      attempt += 1;
      try {
        return await this.callGeminiOnce({
          model: options.model,
          textPrompt: options.textPrompt,
          ...(options.imageUrl ? { imageUrl: options.imageUrl } : {})
        });
      } catch (error) {
        lastError = error;
        const asHttpError = error as HttpError;
        const shouldRetry = Boolean(asHttpError.retryable) && attempt < options.maxAttempts;
        if (!shouldRetry) {
          break;
        }

        const backoff = Math.min(4000, 300 * 2 ** (attempt - 1));
        const jitter = Math.floor(Math.random() * 150);
        await this.wait(backoff + jitter);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Gemini request failed");
  }

  private async generateText(options: {
    model: string;
    fallbackModel?: string;
    textPrompt: string;
    imageUrl?: string;
  }): Promise<string> {
    try {
      return await this.generateWithRetries({
        model: options.model,
        textPrompt: options.textPrompt,
        ...(options.imageUrl ? { imageUrl: options.imageUrl } : {}),
        maxAttempts: 3
      });
    } catch (primaryError) {
      const asHttpError = primaryError as HttpError;
      if (!options.fallbackModel || asHttpError.retryable !== true) {
        throw primaryError;
      }

      return this.generateWithRetries({
        model: options.fallbackModel,
        textPrompt: options.textPrompt,
        ...(options.imageUrl ? { imageUrl: options.imageUrl } : {}),
        maxAttempts: 2
      });
    }
  }

  async evaluateOcrQuality(input: { imageUrl: string; ocrText: string; minScore: number }): Promise<OcrEvaluation> {
    const prompt = [
      "Evaluate OCR text quality against the image.",
      "Return only JSON with keys: score (0-1), isGoodEnough (boolean), canExtractFromText (boolean), correctedOcrText (string).",
      "Do not include markdown.",
      `Minimum score threshold: ${input.minScore}`,
      "OCR text:",
      input.ocrText
    ].join("\n\n");

    const raw = await this.generateText({
      model: this.config.GEMINI_BASIC_MODEL,
      fallbackModel: this.config.GEMINI_ADVANCED_MODEL,
      textPrompt: prompt,
      imageUrl: input.imageUrl
    });

    const parsed = JSON.parse(stripJsonMarkdown(raw)) as Partial<OcrEvaluation>;
    const score = typeof parsed.score === "number" ? Math.min(1, Math.max(0, parsed.score)) : 0;

    const evaluation: OcrEvaluation = {
      score,
      isGoodEnough: typeof parsed.isGoodEnough === "boolean" ? parsed.isGoodEnough : score >= input.minScore,
      canExtractFromText: Boolean(parsed.canExtractFromText)
    };

    if (typeof parsed.correctedOcrText === "string") {
      evaluation.correctedOcrText = parsed.correctedOcrText;
    }

    return evaluation;
  }

  async summarizeFromText(input: { text: string; title?: string; timezone: string }): Promise<{ summary: string; state?: ItemState }> {
    const prompt = [
      "Answer this first: what is this item about? Then summarize in at most 2 concise sentences.",
      "Summary must capture the primary intent (for example hiring notice, scholarship call, event, bill, appointment).",
      "Do not produce contact-only summaries. Mention contact details only after stating the purpose.",
      "Infer state only if explicit processing or failure context exists.",
      "Return only JSON with keys: summary (string), state (READY|PROCESSING|FAILED).",
      "If state is unclear, use READY.",
      `Title: ${input.title ?? "N/A"}`,
      `Timezone context: ${input.timezone}`,
      "Content:",
      input.text
    ].join("\n\n");

    const raw = await this.generateText({
      model: this.config.GEMINI_BASIC_MODEL,
      fallbackModel: this.config.GEMINI_ADVANCED_MODEL,
      textPrompt: prompt
    });

    const parsed = JSON.parse(stripJsonMarkdown(raw)) as Partial<{ summary: string; state: ItemState }>;
    const result: { summary: string; state?: ItemState } = {
      summary: typeof parsed.summary === "string" && parsed.summary.trim().length > 0 ? parsed.summary.trim() : "No summary provided."
    };

    if (parsed.state) {
      result.state = parsed.state;
    }

    return result;
  }

  async extractRawTextFromImage(imageUrl: string): Promise<{ text: string; confidence: number }> {
    const prompt = [
      "Read all visible text from this image and return only JSON.",
      "JSON keys: text (string), confidence (number 0-1).",
      "Do not add markdown."
    ].join("\n\n");

    const raw = await this.generateText({
      model: this.config.GEMINI_BASIC_MODEL,
      fallbackModel: this.config.GEMINI_ADVANCED_MODEL,
      textPrompt: prompt,
      imageUrl
    });

    const parsed = JSON.parse(stripJsonMarkdown(raw)) as Partial<{ text: string; confidence: number }>;
    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5
    };
  }

  async extractFromText(input: {
    text: string;
    timezone: string;
    preferBasicModel: boolean;
  }): Promise<{
    extracted: ExtractedItem;
    confidence: number;
    usedAdvancedModel: boolean;
    model: string;
  }> {
    const prompt = [
      "Extract reminder item details from the provided text.",
      "First determine the primary intent by answering: what is this item about?",
      "Classify by intent, not by organization domain. Example: a hospital recruitment advert is JOB, not HEALTH.",
      "Return only valid JSON with keys: title, summary, category, deadline, eventDate, state, metadata, confidence.",
      "Summary must begin with the core purpose and action, not contact details.",
      "For JOB summaries include role and organization if available.",
      "Categories must be one of: JOB, EVENT, SCHOLARSHIP, MEETING, EXAM, ASSIGNMENT, BILL, PAYMENT, APPOINTMENT, SUBSCRIPTION, TRAVEL, HEALTH, SHOPPING, DOCUMENT, PERSONAL, OTHER.",
      "Category rule: use JOB for vacancies, internships, hiring notices, employment roles, or applications for a role.",
      "Category rule: classify by primary intent and required action, not by organization domain labels.",
      "Category rule: use SCHOLARSHIP only for study funding such as tuition support, bursary, grant, or fellowship.",
      "If job-role signals and scholarship signals both appear, choose JOB unless funding-for-study is the primary intent.",
      "Use YYYY-MM-DD format for deadline/eventDate, or null when unknown. Do not invent fields.",
      "For OTHER category, place extra values under metadata.custom.",
      "State must be READY, PROCESSING, or FAILED.",
      `Timezone context: ${input.timezone}`,
      "Text:",
      input.text
    ].join("\n\n");

    const primaryModel = input.preferBasicModel ? this.config.GEMINI_BASIC_MODEL : this.config.GEMINI_ADVANCED_MODEL;
    const primaryRaw = await this.generateText({
      model: primaryModel,
      fallbackModel: this.config.GEMINI_ADVANCED_MODEL,
      textPrompt: prompt
    });
    const primaryJson = JSON.parse(stripJsonMarkdown(primaryRaw)) as Record<string, unknown>;
    const primaryValidated = extractedItemSchema.safeParse(primaryJson);

    const primaryTitle = typeof primaryJson.title === "string" ? primaryJson.title.trim() : "";
    if (primaryValidated.success && primaryTitle.length > 0) {
      return {
        extracted: primaryValidated.data,
        confidence: typeof primaryJson.confidence === "number" ? Math.min(1, Math.max(0, primaryJson.confidence)) : 0.65,
        usedAdvancedModel: primaryModel === this.config.GEMINI_ADVANCED_MODEL,
        model: primaryModel
      };
    }

    const fallbackRaw = await this.generateText({
      model: this.config.GEMINI_ADVANCED_MODEL,
      textPrompt: prompt
    });
    const fallbackJson = JSON.parse(stripJsonMarkdown(fallbackRaw)) as Record<string, unknown>;
    const fallbackValidated = extractedItemSchema.parse(fallbackJson);

    return {
      extracted: fallbackValidated,
      confidence: typeof fallbackJson.confidence === "number" ? Math.min(1, Math.max(0, fallbackJson.confidence)) : 0.75,
      usedAdvancedModel: true,
      model: this.config.GEMINI_ADVANCED_MODEL
    };
  }

  async extractFromVision(input: {
    imageUrl: string;
    ocrText?: string;
    timezone: string;
    preferBasicModel: boolean;
  }): Promise<VisionExtractionResult> {
    const basePrompt = [
      "Extract reminder item details from this image.",
      "First determine the primary intent by answering: what is this image/file about?",
      "Classify by intent, not by organization domain. Example: a hospital recruitment advert is JOB, not HEALTH.",
      "Return only valid JSON with keys: title, summary, category, deadline, eventDate, state, metadata, confidence.",
      "Summary must begin with the core purpose and action, not contact details.",
      "For JOB summaries include role and organization if available.",
      "Categories must be one of: JOB, EVENT, SCHOLARSHIP, MEETING, EXAM, ASSIGNMENT, BILL, PAYMENT, APPOINTMENT, SUBSCRIPTION, TRAVEL, HEALTH, SHOPPING, DOCUMENT, PERSONAL, OTHER.",
      "Category rule: use JOB for vacancies, internships, hiring notices, employment roles, or applications for a role.",
      "Category rule: classify by primary intent and required action, not by organization domain labels.",
      "Category rule: use SCHOLARSHIP only for study funding such as tuition support, bursary, grant, or fellowship.",
      "If job-role signals and scholarship signals both appear, choose JOB unless funding-for-study is the primary intent.",
      "Use YYYY-MM-DD format for deadline/eventDate, or null when unknown. Do not invent fields.",
      "For OTHER category, place extra values under metadata.custom.",
      "State must be READY, PROCESSING, or FAILED based on explicit context.",
      `Timezone context: ${input.timezone}`,
      input.ocrText ? `OCR hint text:\n${input.ocrText}` : ""
    ]
      .filter(Boolean)
      .join("\n\n");

    const primaryModel = input.preferBasicModel ? this.config.GEMINI_BASIC_MODEL : this.config.GEMINI_ADVANCED_MODEL;
    const primaryRaw = await this.generateText({
      model: primaryModel,
      fallbackModel: this.config.GEMINI_ADVANCED_MODEL,
      textPrompt: basePrompt,
      imageUrl: input.imageUrl
    });

    const primaryJson = JSON.parse(stripJsonMarkdown(primaryRaw)) as Record<string, unknown>;
    const primaryValidated = extractedItemSchema.safeParse(primaryJson);

    const primaryTitle = typeof primaryJson.title === "string" ? primaryJson.title.trim() : "";
    if (primaryValidated.success && primaryTitle.length > 0) {
      return {
        extracted: primaryValidated.data,
        confidence: typeof primaryJson.confidence === "number" ? Math.min(1, Math.max(0, primaryJson.confidence)) : 0.65,
        usedAdvancedModel: primaryModel === this.config.GEMINI_ADVANCED_MODEL,
        model: primaryModel
      };
    }

    const fallbackRaw = await this.generateText({
      model: this.config.GEMINI_ADVANCED_MODEL,
      textPrompt: basePrompt,
      imageUrl: input.imageUrl
    });
    const fallbackJson = JSON.parse(stripJsonMarkdown(fallbackRaw)) as Record<string, unknown>;
    const fallbackValidated = extractedItemSchema.parse(fallbackJson);

    return {
      extracted: fallbackValidated,
      confidence: typeof fallbackJson.confidence === "number" ? Math.min(1, Math.max(0, fallbackJson.confidence)) : 0.75,
      usedAdvancedModel: true,
      model: this.config.GEMINI_ADVANCED_MODEL
    };
  }
}
