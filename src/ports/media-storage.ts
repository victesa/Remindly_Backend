export type UploadMediaInput = {
  uid: string;
  itemId: string;
  contentType: string;
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
};

export type StoredMedia = {
  objectKey: string;
  readUrl: string;
  mimeType: string;
  size: number;
};

export interface MediaStorage {
  uploadAndCreateReadUrl(input: UploadMediaInput): Promise<StoredMedia>;
}
