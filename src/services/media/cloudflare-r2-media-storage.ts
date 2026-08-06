import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "../../config/env.js";
import type { MediaStorage, StoredMedia, UploadMediaInput } from "../../ports/media-storage.js";

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt"
};

function safeFileNameSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function inferExtension(mimeType: string, fileName?: string): string {
  const trimmed = fileName?.trim();
  if (trimmed && trimmed.includes(".")) {
    const ext = trimmed.split(".").pop();
    if (ext) {
      return safeFileNameSegment(ext.toLowerCase());
    }
  }

  return EXTENSION_BY_MIME[mimeType] ?? "bin";
}

export class CloudflareR2MediaStorage implements MediaStorage {
  private readonly s3: S3Client;

  constructor(private readonly config: AppConfig) {
    const s3Config: {
      region: string;
      endpoint?: string;
      credentials?: {
        accessKeyId: string;
        secretAccessKey: string;
      };
    } = {
      region: "auto",
    };

    if (config.CLOUDFLARE_R2_ENDPOINT) {
      s3Config.endpoint = config.CLOUDFLARE_R2_ENDPOINT;
    }

    if (config.CLOUDFLARE_R2_ACCESS_KEY_ID && config.CLOUDFLARE_R2_SECRET_ACCESS_KEY) {
      s3Config.credentials = {
        accessKeyId: config.CLOUDFLARE_R2_ACCESS_KEY_ID,
        secretAccessKey: config.CLOUDFLARE_R2_SECRET_ACCESS_KEY
      };
    }

    this.s3 = new S3Client(s3Config);
  }

  private assertUploadConfiguration(): void {
    if (!this.config.CLOUDFLARE_R2_ENDPOINT) {
      throw new Error("CLOUDFLARE_R2_ENDPOINT is required when media upload is used");
    }

    if (!this.config.CLOUDFLARE_R2_ACCESS_KEY_ID || !this.config.CLOUDFLARE_R2_SECRET_ACCESS_KEY) {
      throw new Error("CLOUDFLARE_R2_ACCESS_KEY_ID and CLOUDFLARE_R2_SECRET_ACCESS_KEY are required when media upload is used");
    }

    if (!this.config.CLOUDFLARE_R2_BUCKET) {
      throw new Error("CLOUDFLARE_R2_BUCKET is required when media upload is used");
    }
  }

  private getBucket(): string {
    if (!this.config.CLOUDFLARE_R2_BUCKET) {
      throw new Error("CLOUDFLARE_R2_BUCKET is required for media uploads");
    }

    return this.config.CLOUDFLARE_R2_BUCKET;
  }

  private getSignedUrlTtlSeconds(): number {
    return this.config.CLOUDFLARE_R2_SIGNED_URL_TTL_SECONDS ?? 900;
  }

  async uploadAndCreateReadUrl(input: UploadMediaInput): Promise<StoredMedia> {
    this.assertUploadConfiguration();
    const bucket = this.getBucket();
    const extension = inferExtension(input.mimeType, input.fileName);
    const objectKey = `uploads/${input.uid}/${input.itemId}/${randomUUID()}.${extension}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: input.buffer,
        ContentType: input.mimeType,
        Metadata: {
          contentType: input.contentType
        }
      })
    );

    const signedReadUrl = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey
      }),
      {
        expiresIn: this.getSignedUrlTtlSeconds()
      }
    );

    return {
      objectKey,
      readUrl: signedReadUrl,
      mimeType: input.mimeType,
      size: input.buffer.length
    };
  }
}
