import type { ExtractedItem } from "../../contracts/ingest.js";

const JOB_TERMS = [
  /\bjob(s)?\b/i,
  /\bvacanc(y|ies)\b/i,
  /\bposition(s)?\b/i,
  /\bhiring\b/i,
  /\brecruit(ment|ing)?\b/i,
  /\bintern(ship)?\b/i,
  /\bcareer(s)?\b/i,
  /\brole(s)?\b/i,
  /\bfull[-\s]?time\b/i,
  /\bpart[-\s]?time\b/i,
  /\bresponsibilit(y|ies)\b/i,
  /\bqualification(s)?\b/i,
  /\bcv\b/i,
  /\bresume\b/i,
  /\bsalary\b/i,
  /\bremuneration\b/i
];

const SCHOLARSHIP_TERMS = [
  /\bscholarship(s)?\b/i,
  /\bbursar(y|ies)\b/i,
  /\bgrant(s)?\b/i,
  /\bfellowship(s)?\b/i,
  /\btuition\b/i,
  /\bfinancial\s+aid\b/i,
  /\bsponsor(ship)?\b/i,
  /\bstipend\b/i,
  /\bundergraduate\b/i,
  /\bpostgraduate\b/i
];

function flattenMetadataValues(metadata: Record<string, unknown>): string[] {
  const values: string[] = [];

  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      values.push(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    if (typeof value === "object" && value !== null) {
      for (const nested of Object.values(value)) {
        visit(nested);
      }
    }
  };

  visit(metadata);
  return values;
}

function scoreMatches(text: string, patterns: RegExp[]): number {
  let score = 0;

  for (const pattern of patterns) {
    if (pattern.test(text)) {
      score += 1;
    }
  }

  return score;
}

function buildSignalText(extracted: ExtractedItem, sourceText?: string): string {
  const metadataValues = flattenMetadataValues(extracted.metadata)
    .join(" ")
    .trim();

  return [
    extracted.title,
    extracted.summary,
    metadataValues,
    sourceText ?? ""
  ]
    .join("\n")
    .trim();
}

type CategoryCalibrationResult = {
  extracted: ExtractedItem;
  changed: boolean;
  reason?: string;
};

export function calibrateJobScholarshipCategory(extracted: ExtractedItem, sourceText?: string): CategoryCalibrationResult {
  const signalText = buildSignalText(extracted, sourceText);
  if (!signalText) {
    return { extracted, changed: false };
  }

  const lower = signalText.toLowerCase();
  let jobScore = scoreMatches(lower, JOB_TERMS);
  let scholarshipScore = scoreMatches(lower, SCHOLARSHIP_TERMS);

  if (/\b(apply|application|applications)\b/.test(lower) && /\b(job|position|role|intern(ship)?)\b/.test(lower)) {
    jobScore += 2;
  }

  if (/\b(university|college|campus|degree)\b/.test(lower) && /\b(scholarship|bursary|grant|fellowship)\b/.test(lower)) {
    scholarshipScore += 2;
  }

  const winner = jobScore > scholarshipScore ? "JOB" : scholarshipScore > jobScore ? "SCHOLARSHIP" : extracted.category;
  const scoreGap = Math.abs(jobScore - scholarshipScore);

  if ((winner === "JOB" || winner === "SCHOLARSHIP") && winner !== extracted.category && scoreGap >= 2) {
    return {
      extracted: {
        ...extracted,
        category: winner
      },
      changed: true,
      reason: `Adjusted category from ${extracted.category} to ${winner} based on text signals (JOB=${jobScore}, SCHOLARSHIP=${scholarshipScore})`
    };
  }

  return { extracted, changed: false };
}