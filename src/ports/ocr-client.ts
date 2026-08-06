export type OcrFallbackResult = {
  text: string;
  confidence: number;
};

export interface OcrClient {
  extractFromImage(imageUrl: string): Promise<OcrFallbackResult>;
}
