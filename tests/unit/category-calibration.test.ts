import { describe, expect, it } from "vitest";
import type { ExtractedItem } from "../../src/contracts/ingest.js";
import { calibrateJobScholarshipCategory } from "../../src/services/extraction/category-calibration.js";

function buildExtractedItem(overrides?: Partial<ExtractedItem>): ExtractedItem {
  return {
    title: "Sample item",
    summary: "Sample summary",
    category: "OTHER",
    deadline: null,
    eventDate: null,
    state: "READY",
    metadata: {},
    ...overrides
  };
}

describe("calibrateJobScholarshipCategory", () => {
  it("reclassifies scholarship to job when hiring signals are stronger", () => {
    const extracted = buildExtractedItem({
      title: "Graduate Internship Applications",
      summary: "Apply for software engineering internship positions at Acme Careers",
      category: "SCHOLARSHIP",
      metadata: {
        website: "https://careers.acme.com"
      }
    });

    const result = calibrateJobScholarshipCategory(
      extracted,
      "Acme is hiring graduate interns. Submit CV and application for the role."
    );

    expect(result.changed).toBe(true);
    expect(result.extracted.category).toBe("JOB");
  });

  it("keeps scholarship when study-funding signals are dominant", () => {
    const extracted = buildExtractedItem({
      title: "STEM Scholarship 2027",
      summary: "Tuition grant for undergraduate students",
      category: "SCHOLARSHIP",
      metadata: {
        institution: "Acme University",
        applicationLink: "https://acme.edu/scholarships"
      }
    });

    const result = calibrateJobScholarshipCategory(
      extracted,
      "This scholarship offers tuition support and financial aid for degree students."
    );

    expect(result.changed).toBe(false);
    expect(result.extracted.category).toBe("SCHOLARSHIP");
  });

  it("does not force a category when signals are weak or tied", () => {
    const extracted = buildExtractedItem({
      title: "Application notice",
      summary: "Please apply before deadline",
      category: "SCHOLARSHIP"
    });

    const result = calibrateJobScholarshipCategory(extracted);

    expect(result.changed).toBe(false);
    expect(result.extracted.category).toBe("SCHOLARSHIP");
  });

});
