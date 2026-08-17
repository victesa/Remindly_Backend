import type { IngestRequest } from "../../contracts/ingest.js";
import type { AppConfig } from "../../config/env.js";
import { sanitizeMetadata, type Item } from "../../domain/item.js";
import type { GeminiAi } from "../../ports/gemini-ai.js";
import type { ItemRepository } from "../../ports/item-repository.js";
import type { MediaStorage } from "../../ports/media-storage.js";
import type { OcrClient } from "../../ports/ocr-client.js";
import { TextExtractor } from "../extraction/text-extractor.js";
import { calibrateJobScholarshipCategory } from "../extraction/category-calibration.js";
import { createHash } from "node:crypto";

export type PipelineResult = {
  item: Item;
  extraction: {
    strategy: "OCR_PLUS_SUMMARY" | "VISION_FULL_EXTRACTION" | "TEXT_FULL_EXTRACTION";
    confidence: number;
    ocrQualityScore: number;
  };
};

export class IngestPipeline {
  private readonly stageTimeoutMs = 45_000;
  private readonly maxInferenceTextLength = 12_000;
  private readonly visionSupportedMimeTypes = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"]);

  constructor(
    private readonly config: AppConfig,
    private readonly geminiAi: GeminiAi,
    private readonly itemRepository: ItemRepository,
    private readonly mediaStorage: MediaStorage,
    private readonly ocrClient: OcrClient,
    private readonly textExtractor: TextExtractor
  ) {}

  private async withStageTimeout<T>(label: string, operation: Promise<T>): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error(`${label} timed out after ${this.stageTimeoutMs}ms`) as Error & { statusCode?: number };
        error.statusCode = 503;
        reject(error);
      }, this.stageTimeoutMs);
    });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private isValidTimezone(timezone: string): boolean {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
      return true;
    } catch {
      return false;
    }
  }

  private getEffectiveTimezone(inputTimezone?: string): string {
    const candidate = inputTimezone?.trim();
    if (candidate && this.isValidTimezone(candidate)) {
      return candidate;
    }

    if (this.isValidTimezone(this.config.DEFAULT_TIMEZONE)) {
      return this.config.DEFAULT_TIMEZONE;
    }

    return "UTC";
  }

  private buildIdempotencyKey(uid: string, request: IngestRequest): string {
    const sourceUrl = this.resolveSourceUrl(request);
    const parts = [
      uid,
      request.itemId,
      request.contentType,
      request.capturedAt ?? "",
      request.extractedText ?? "",
      sourceUrl ?? "",
      request.media?.mimeType ?? "",
      String(request.media?.size ?? 0)
    ];
    return createHash("sha256").update(parts.join("|")).digest("hex");
  }

  private looksLikeHttpUrl(value: string): boolean {
    try {
      const parsed = new URL(value.trim());
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  private isBlockedHostname(hostname: string): boolean {
    const normalized = hostname.trim().toLowerCase();

    if (!normalized) {
      return true;
    }

    if (
      normalized === "localhost" ||
      normalized === "127.0.0.1" ||
      normalized === "::1" ||
      normalized.endsWith(".local")
    ) {
      return true;
    }

    const privateIpv4 =
      /^10\./.test(normalized) ||
      /^127\./.test(normalized) ||
      /^192\.168\./.test(normalized) ||
      /^169\.254\./.test(normalized) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(normalized);

    return privateIpv4;
  }

  private resolveSourceUrl(request: IngestRequest): string | null {
    const candidates: unknown[] = [
      request.metadata?.source,
      request.metadata?.extra?.url,
      request.metadata?.extra?.link,
      request.metadata?.extra?.sourceUrl,
      request.metadata?.extra?.website
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }

      const trimmed = candidate.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const url = new URL(trimmed);
        if ((url.protocol === "http:" || url.protocol === "https:") && !this.isBlockedHostname(url.hostname)) {
          return url.toString();
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private decodeHtmlEntities(input: string): string {
    return input
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }

  private extractTextFromHtml(html: string): string {
    return this.decodeHtmlEntities(
      html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
      .replace(/\s+/g, " ")
      .trim();
  }

  private limitTextForInference(input: string): string {
    if (input.length <= this.maxInferenceTextLength) {
      return input;
    }

    const clipped = input.slice(0, this.maxInferenceTextLength);
    const lastBoundary = Math.max(clipped.lastIndexOf("."), clipped.lastIndexOf("\n"), clipped.lastIndexOf(" "));
    if (lastBoundary > this.maxInferenceTextLength * 0.75) {
      return clipped.slice(0, lastBoundary).trim();
    }

    return clipped.trim();
  }

  private async fetchSourceText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8"
        }
      });

      if (!response.ok) {
        return "";
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml+xml")) {
        return "";
      }

      const body = await response.text();
      const limited = body.slice(0, 200_000);
      const extracted = contentType.includes("text/plain") ? limited.replace(/\s+/g, " ").trim() : this.extractTextFromHtml(limited);
      return this.limitTextForInference(extracted);
    } catch {
      return "";
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeDateOnly(value: string | null): string | null {
    if (!value) {
      return null;
    }

    const direct = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (direct) {
      return `${direct[1]}-${direct[2]}-${direct[3]}`;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return parsed.toISOString().slice(0, 10);
  }

  private isVisionSupportedMimeType(mimeType?: string | null): boolean {
    if (!mimeType) {
      return false;
    }

    return this.visionSupportedMimeTypes.has(mimeType.trim().toLowerCase());
  }

  private createBadRequestError(message: string): Error & { statusCode: number } {
    const error = new Error(message) as Error & { statusCode: number };
    error.statusCode = 400;
    return error;
  }

  async run(uid: string, request: IngestRequest): Promise<PipelineResult> {
    const effectiveTimezone = this.getEffectiveTimezone(request.metadata?.timezone);
    const idempotencyKey = this.buildIdempotencyKey(uid, request);
    const sourceUrl = this.resolveSourceUrl(request);
    const storedMedia = request.media
      ? await this.withStageTimeout(
          "mediaStorage.uploadAndCreateReadUrl",
          this.mediaStorage.uploadAndCreateReadUrl({
          uid,
          itemId: request.itemId,
          contentType: request.contentType,
          buffer: request.media.buffer,
          mimeType: request.media.mimeType,
          ...(request.media.fileName ? { fileName: request.media.fileName } : {})
          })
        )
      : null;
    const normalizedMimeType = (request.mimeType ?? request.media?.mimeType ?? "").trim().toLowerCase();
    const canUseVision = Boolean(storedMedia?.readUrl) && this.isVisionSupportedMimeType(normalizedMimeType);
    const imageUrl = request.contentType === "IMAGE" || request.contentType === "DOCUMENT"
      ? canUseVision
        ? storedMedia?.readUrl ?? null
        : null
      : null;

    let ocrText = request.extractedText?.trim() ?? "";
    let sourceContentFetched = false;
    let extractionStrategy: PipelineResult["extraction"]["strategy"] = "TEXT_FULL_EXTRACTION";
    let extractionConfidence = 0;
    let ocrQualityScore = 0;
    let extractionModel = this.config.GEMINI_BASIC_MODEL;
    let usedAdvancedModel = false;

    const shouldRunFallbackOcr = Boolean(imageUrl) && !request.extractedText;

    if (!ocrText && imageUrl && shouldRunFallbackOcr) {
      const fallbackOcr = await this.withStageTimeout("ocrClient.extractFromImage", this.ocrClient.extractFromImage(imageUrl));
      ocrText = fallbackOcr.text;
    }

    const extractedTextIsUrlOnly = ocrText.length > 0 && this.looksLikeHttpUrl(ocrText);
    const effectiveSourceUrl = sourceUrl ?? (extractedTextIsUrlOnly ? ocrText.trim() : null);

    if ((!ocrText || extractedTextIsUrlOnly) && effectiveSourceUrl) {
      const sourceText = await this.fetchSourceText(effectiveSourceUrl);
      if (sourceText.length > 0) {
        ocrText = `${sourceText}\n\nSource URL: ${effectiveSourceUrl}`;
        sourceContentFetched = true;
      }
    }

    if (ocrText.length > 0) {
      ocrText = this.limitTextForInference(ocrText);
    }

    const canSkipQualityEvaluation = Boolean(imageUrl) && !request.extractedText && !sourceContentFetched;

    const quality = imageUrl && !canSkipQualityEvaluation
      ? await this.withStageTimeout(
          "geminiAi.evaluateOcrQuality",
          this.geminiAi.evaluateOcrQuality({
            imageUrl,
            ocrText,
            minScore: this.config.OCR_MIN_SCORE
          })
        )
        : {
          score: ocrText.length > 0 ? 1 : 0,
          isGoodEnough: ocrText.length > 0,
          canExtractFromText: ocrText.length > 0
        };

    ocrQualityScore = quality.score;

    const correctedText = quality.correctedOcrText?.trim();
    if (correctedText) {
      ocrText = correctedText;
    }

    let saved: Item;

    if (!sourceContentFetched && quality.isGoodEnough && quality.canExtractFromText && ocrText.length > 0) {
      try {
        const textResult = await this.withStageTimeout(
          "geminiAi.extractFromText",
          this.geminiAi.extractFromText({
            text: ocrText,
            timezone: effectiveTimezone,
            preferBasicModel: true
          })
        );
        const calibrated = calibrateJobScholarshipCategory(textResult.extracted, ocrText);
        if (calibrated.changed) {
          extractionModel = `${textResult.model}+category-calibration`;
        }

        extractionStrategy = "TEXT_FULL_EXTRACTION";
        extractionConfidence = textResult.confidence;
        extractionModel = calibrated.changed ? extractionModel : textResult.model;
        usedAdvancedModel = textResult.usedAdvancedModel;

        saved = await this.withStageTimeout(
          "itemRepository.save",
          this.itemRepository.save({
          uid,
          itemId: request.itemId,
          title: calibrated.extracted.title,
          summary: calibrated.extracted.summary,
          category: calibrated.extracted.category,
          deadline: this.normalizeDateOnly(calibrated.extracted.deadline),
          eventDate: this.normalizeDateOnly(calibrated.extracted.eventDate),
          state: "READY",
          metadata: sanitizeMetadata(calibrated.extracted.category, calibrated.extracted.metadata),
          audit: {
            idempotencyKey,
            source: {
              itemId: request.itemId,
              contentType: request.contentType,
              storagePath: storedMedia?.objectKey ?? null,
              imageUrl,
              mimeType: request.mimeType ?? request.media?.mimeType ?? null,
              sourceUrl: effectiveSourceUrl,
              sourceContentFetched,
              capturedAt: request.capturedAt ?? null,
              receivedAt: new Date().toISOString(),
              extractedTextProvided: Boolean(request.extractedText)
            },
            extraction: {
              strategy: extractionStrategy,
              confidence: extractionConfidence,
              ocrQualityScore,
              effectiveTimezone,
              model: extractionModel,
              usedAdvancedModel
            }
          }
          })
        );

        return { item: saved, extraction: { strategy: extractionStrategy, confidence: extractionConfidence, ocrQualityScore } };
      } catch (error) {
        if (!imageUrl) {
          throw error;
        }
      }
    }

    if (imageUrl) {
      const visionResult = await this.withStageTimeout(
        "geminiAi.extractFromVision",
        this.geminiAi.extractFromVision({
          imageUrl,
          ocrText,
          timezone: effectiveTimezone,
          preferBasicModel: true
        })
      );
      const calibrated = calibrateJobScholarshipCategory(visionResult.extracted, ocrText);
      if (calibrated.changed) {
        extractionModel = `${visionResult.model}+category-calibration`;
      }

      extractionStrategy = "VISION_FULL_EXTRACTION";
      extractionConfidence = visionResult.confidence;
      extractionModel = calibrated.changed ? extractionModel : visionResult.model;
      usedAdvancedModel = visionResult.usedAdvancedModel;

      saved = await this.withStageTimeout(
        "itemRepository.save",
        this.itemRepository.save({
        uid,
        itemId: request.itemId,
        title: calibrated.extracted.title,
        summary: calibrated.extracted.summary,
        category: calibrated.extracted.category,
        deadline: this.normalizeDateOnly(calibrated.extracted.deadline),
        eventDate: this.normalizeDateOnly(calibrated.extracted.eventDate),
        state: "READY",
        metadata: sanitizeMetadata(calibrated.extracted.category, calibrated.extracted.metadata),
        audit: {
          idempotencyKey,
          source: {
            itemId: request.itemId,
            contentType: request.contentType,
            storagePath: storedMedia?.objectKey ?? null,
            imageUrl,
            mimeType: request.mimeType ?? request.media?.mimeType ?? null,
              sourceUrl: effectiveSourceUrl,
              sourceContentFetched,
            capturedAt: request.capturedAt ?? null,
            receivedAt: new Date().toISOString(),
            extractedTextProvided: Boolean(request.extractedText)
          },
          extraction: {
            strategy: extractionStrategy,
            confidence: extractionConfidence,
            ocrQualityScore,
            effectiveTimezone,
            model: extractionModel,
            usedAdvancedModel
          }
        }
        })
      );

      return { item: saved, extraction: { strategy: extractionStrategy, confidence: extractionConfidence, ocrQualityScore } };
    }

    if (!ocrText) {
      if (storedMedia && !canUseVision) {
        throw this.createBadRequestError(
          "Unsupported media format for vision extraction. For DOCUMENT uploads such as PDF, include extractedText from client OCR, provide a source URL, or upload an image format (png, jpeg, gif, webp)."
        );
      }

      throw this.createBadRequestError("No usable content found for extraction. Provide extractedText, a source URL, or supported image media.");
    }

    const textResult = await this.withStageTimeout(
      "geminiAi.extractFromText",
      this.geminiAi.extractFromText({
        text: ocrText,
        timezone: effectiveTimezone,
        preferBasicModel: true
      })
    );
    const calibrated = calibrateJobScholarshipCategory(textResult.extracted, ocrText);
    if (calibrated.changed) {
      extractionModel = `${textResult.model}+category-calibration`;
    }

    extractionStrategy = "TEXT_FULL_EXTRACTION";
    extractionConfidence = textResult.confidence;
    extractionModel = calibrated.changed ? extractionModel : textResult.model;
    usedAdvancedModel = textResult.usedAdvancedModel;

    saved = await this.withStageTimeout(
      "itemRepository.save",
      this.itemRepository.save({
      uid,
      itemId: request.itemId,
      title: calibrated.extracted.title,
      summary: calibrated.extracted.summary,
      category: calibrated.extracted.category,
      deadline: this.normalizeDateOnly(calibrated.extracted.deadline),
      eventDate: this.normalizeDateOnly(calibrated.extracted.eventDate),
      state: "READY",
      metadata: sanitizeMetadata(calibrated.extracted.category, calibrated.extracted.metadata),
      audit: {
        idempotencyKey,
        source: {
          itemId: request.itemId,
          contentType: request.contentType,
          storagePath: storedMedia?.objectKey ?? null,
          imageUrl,
          mimeType: request.mimeType ?? request.media?.mimeType ?? null,
          sourceUrl: effectiveSourceUrl,
          sourceContentFetched,
          capturedAt: request.capturedAt ?? null,
          receivedAt: new Date().toISOString(),
          extractedTextProvided: Boolean(request.extractedText)
        },
        extraction: {
          strategy: extractionStrategy,
          confidence: extractionConfidence,
          ocrQualityScore,
          effectiveTimezone,
          model: extractionModel,
          usedAdvancedModel
        }
      }
      })
    );

    return { item: saved, extraction: { strategy: extractionStrategy, confidence: extractionConfidence, ocrQualityScore } };
  }
}
