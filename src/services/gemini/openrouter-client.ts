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

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

function stripJsonMarkdown(text: string): string {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
}

export class OpenRouterClient implements GeminiAi {
  constructor(private readonly config: AppConfig) {}

  private readonly requestTimeoutMs = 45_000;

  private createHttpError(message: string, statusCode: number, retryable: boolean): HttpError {
    const error = new Error(message) as HttpError;
    error.statusCode = statusCode;
    error.code = "UPSTREAM_OPENROUTER_ERROR";
    error.retryable = retryable;
    return error;
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || status === 503 || (status >= 500 && status <= 599);
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private resolveOpenRouterUrl(): string {
    const base = this.config.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
    return `${base.replace(/\/+$/, "")}/chat/completions`;
  }

  private extractTextContent(response: OpenRouterResponse): string {
    const content = response.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return content.trim();
    }

    if (Array.isArray(content)) {
      const text = content
        .map((chunk) => (typeof chunk.text === "string" ? chunk.text : ""))
        .join("\n")
        .trim();
      return text;
    }

    return "";
  }

  private async callOpenRouterOnce(options: {
    model: string;
    prompt: string;
    imageUrl?: string;
  }): Promise<string> {
    const apiKey = this.config.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw this.createHttpError("OPENROUTER_API_KEY is missing for openrouter provider", 500, false);
    }

    const messageContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }> = options.imageUrl
      ? [
          { type: "text", text: options.prompt },
          { type: "image_url", image_url: { url: options.imageUrl } }
        ]
      : options.prompt;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(this.resolveOpenRouterUrl(), {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: options.model,
          messages: [
            {
              role: "user",
              content: messageContent
            }
          ]
        })
      });

      if (!response.ok) {
        const body = await response.text();
        throw this.createHttpError(`OpenRouter request failed (${response.status}): ${body}`, response.status, this.isRetryableStatus(response.status));
      }

      const parsed = (await response.json()) as OpenRouterResponse;
      const text = this.extractTextContent(parsed);
      if (!text) {
        throw this.createHttpError("OpenRouter returned empty content", 502, true);
      }

      return text;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callOpenRouter(options: {
    model: string;
    prompt: string;
    imageUrl?: string;
  }): Promise<string> {
    try {
      return await this.callOpenRouterOnce(options);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw this.createHttpError("OpenRouter request timed out", 504, true);
      }

      throw error;
    }
  }

  private async completeWithRetries(options: {
    primaryModel: string;
    fallbackModel?: string;
    prompt: string;
    imageUrl?: string;
  }): Promise<{ text: string; model: string }> {
    const tryModel = async (model: string, attempts: number): Promise<string> => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await this.callOpenRouter({
            model,
            prompt: options.prompt,
            ...(options.imageUrl ? { imageUrl: options.imageUrl } : {})
          });
        } catch (error) {
          lastError = error;
          const asHttpError = error as HttpError;
          if (!asHttpError.retryable || attempt === attempts) {
            break;
          }

          const backoff = Math.min(4000, 300 * 2 ** (attempt - 1));
          const jitter = Math.floor(Math.random() * 150);
          await this.wait(backoff + jitter);
        }
      }

      throw lastError instanceof Error ? lastError : new Error("OpenRouter request failed");
    };

    try {
      const text = await tryModel(options.primaryModel, 3);
      return { text, model: options.primaryModel };
    } catch (error) {
      const asHttpError = error as HttpError;
      if (!options.fallbackModel || options.fallbackModel === options.primaryModel || asHttpError.retryable !== true) {
        throw error;
      }

      const text = await tryModel(options.fallbackModel, 2);
      return { text, model: options.fallbackModel };
    }
  }

  private getBasicModel(): string {
    return this.config.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
  }

  private getAdvancedModel(): string {
    return this.config.OPENROUTER_ADVANCED_MODEL ?? this.getBasicModel();
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

    const completed = await this.completeWithRetries({
      primaryModel: this.getBasicModel(),
      fallbackModel: this.getAdvancedModel(),
      prompt,
      imageUrl: input.imageUrl
    });

    const parsed = JSON.parse(stripJsonMarkdown(completed.text)) as Partial<OcrEvaluation>;
    const score = typeof parsed.score === "number" ? Math.min(1, Math.max(0, parsed.score)) : 0;

    const evaluation: OcrEvaluation = {
      score,
      isGoodEnough: typeof parsed.isGoodEnough === "boolean" ? parsed.isGoodEnough : score >= input.minScore,
      canExtractFromText: typeof parsed.canExtractFromText === "boolean" ? parsed.canExtractFromText : score >= input.minScore
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

    const completed = await this.completeWithRetries({
      primaryModel: this.getBasicModel(),
      fallbackModel: this.getAdvancedModel(),
      prompt
    });

    const parsed = JSON.parse(stripJsonMarkdown(completed.text)) as Partial<{ summary: string; state: ItemState }>;
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

    const completed = await this.completeWithRetries({
      primaryModel: this.getBasicModel(),
      fallbackModel: this.getAdvancedModel(),
      prompt,
      imageUrl
    });

    const parsed = JSON.parse(stripJsonMarkdown(completed.text)) as Partial<{ text: string; confidence: number }>;
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

    const primaryModel = input.preferBasicModel ? this.getBasicModel() : this.getAdvancedModel();
    const fallbackModel = this.getAdvancedModel();

    const completed = await this.completeWithRetries({
      primaryModel,
      fallbackModel,
      prompt
    });

    const parsed = JSON.parse(stripJsonMarkdown(completed.text)) as Record<string, unknown>;
    const validated = extractedItemSchema.parse(parsed);
    const confidence = typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.65;

    return {
      extracted: validated,
      confidence,
      usedAdvancedModel: completed.model === this.getAdvancedModel() && completed.model !== this.getBasicModel(),
      model: completed.model
    };
  }

  async extractFromVision(input: {
    imageUrl: string;
    ocrText?: string;
    timezone: string;
    preferBasicModel: boolean;
  }): Promise<VisionExtractionResult> {
    const prompt = [
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

    const primaryModel = input.preferBasicModel ? this.getBasicModel() : this.getAdvancedModel();
    const fallbackModel = this.getAdvancedModel();

    const completed = await this.completeWithRetries({
      primaryModel,
      fallbackModel,
      prompt,
      imageUrl: input.imageUrl
    });

    const parsed = JSON.parse(stripJsonMarkdown(completed.text)) as Record<string, unknown>;
    const validated = extractedItemSchema.parse(parsed);
    const confidence = typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.65;

    return {
      extracted: validated,
      confidence,
      usedAdvancedModel: completed.model === this.getAdvancedModel() && completed.model !== this.getBasicModel(),
      model: completed.model
    };
  }
}
