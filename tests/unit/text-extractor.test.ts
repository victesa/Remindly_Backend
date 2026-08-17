import { describe, expect, it } from "vitest";
import { TextExtractor } from "../../src/services/extraction/text-extractor.js";

describe("TextExtractor", () => {
  it("extracts title category date and metadata from OCR text", () => {
    const extractor = new TextExtractor();
    const text = [
      "Google Hiring Event",
      "Apply now for software engineering role",
      "Date: 2026-08-15",
      "Contact: talent@google.com",
      "Website: https://careers.google.com"
    ].join("\n");

    const result = extractor.extract(text);

    expect(result.extracted.title).toBe("Google Hiring Event");
    expect(result.extracted.category).toBe("JOB");
    expect(result.extracted.deadline).toBe("2026-08-15");
    expect(result.extracted.metadata.contactEmail).toBe("talent@google.com");
    expect(result.extracted.metadata.website).toBe("https://careers.google.com");
    expect(result.completenessScore).toBeGreaterThan(0.5);
  });

  it("produces concise title and date/company metadata from long sentence", () => {
    const extractor = new TextExtractor();
    const text =
      "Google Internship Applications are now open. Deadline is 31 August 2026. Apply at https://careers.google.com. Contact internships@google.com.";

    const result = extractor.extract(text);

    expect(result.extracted.title).toBe("Google Internship Applications");
    expect(result.extracted.deadline).toBe("2026-08-31");
    expect(result.extracted.metadata.company).toBe("Google");
    expect(result.extracted.metadata.website).toBe("https://careers.google.com");
    expect(result.extracted.metadata.contactEmail).toBe("internships@google.com");
  });

  it("classifies hospital hiring adverts as JOB instead of HEALTH", () => {
    const extractor = new TextExtractor();
    const text = [
      "St. Mary Hospital Hiring Notice",
      "Applications are open for Nursing Officer positions",
      "Minimum qualifications and CV required",
      "Apply before 2026-09-10"
    ].join("\n");

    const result = extractor.extract(text);

    expect(result.extracted.category).toBe("JOB");
  });
});
