import type { ExtractedItem } from "../../contracts/ingest.js";
import { ITEM_CATEGORIES } from "../../domain/item.js";

const categoryHints: Record<string, string[]> = {
  JOB: ["job", "position", "apply", "vacancy", "hiring", "salary"],
  EVENT: ["event", "register", "venue", "ticket", "organiser"],
  SCHOLARSHIP: ["scholarship", "funding", "eligibility", "application"],
  MEETING: ["meeting", "agenda", "attendees", "conference"],
  EXAM: ["exam", "subject", "candidate", "invigilator"],
  ASSIGNMENT: ["assignment", "lecturer", "submission", "course"],
  BILL: ["bill", "invoice", "due", "provider", "account"],
  PAYMENT: ["payment", "recipient", "reference", "transfer"],
  APPOINTMENT: ["appointment", "clinic", "doctor", "schedule"],
  SUBSCRIPTION: ["subscription", "renewal", "plan", "monthly"],
  TRAVEL: ["flight", "travel", "destination", "departure", "booking"],
  HEALTH: ["hospital", "doctor", "health", "patient"],
  SHOPPING: ["shopping", "store", "receipt", "total"],
  DOCUMENT: ["document", "issued", "reference", "certificate"],
  PERSONAL: ["personal", "note", "reminder"]
};

const employmentSignals = [
  /\bjob(s)?\b/i,
  /\bvacanc(y|ies)\b/i,
  /\bposition(s)?\b/i,
  /\bhiring\b/i,
  /\brecruit(ment|ing)?\b/i,
  /\bintern(ship)?\b/i,
  /\bcareer(s)?\b/i,
  /\brole(s)?\b/i,
  /\bapply\b/i,
  /\bapplication(s)?\b/i,
  /\bcv\b/i,
  /\bresume\b/i,
  /\bqualification(s)?\b/i,
  /\bexperience\b/i
];

const appointmentSignals = [
  /\bappointment(s)?\b/i,
  /\bclinic\b/i,
  /\bpatient\b/i,
  /\bdoctor\s+appointment\b/i,
  /\bcheck[-\s]?up\b/i,
  /\bprescription\b/i
];

function firstNonEmptyLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);

  return line ?? "Untitled Item";
}

function toTitleCase(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function deriveTitle(text: string): string {
  const firstLine = firstNonEmptyLine(text);
  const firstSentence = text.split(/[.!?]\s+/)[0]?.trim() ?? firstLine;
  let candidate = firstLine.length <= 90 ? firstLine : firstSentence;

  const openPattern = candidate.match(/^(.*?)\s+are\s+now\s+open\b/i);
  if (openPattern?.[1]) {
    candidate = openPattern[1].trim();
  }

  candidate = candidate.replace(/\b(deadline|apply|contact)\b.*$/i, "").trim();
  candidate = candidate.replace(/[.,;:!?]+$/g, "").trim();

  if (!candidate) {
    return "Untitled Item";
  }

  const words = candidate.split(/\s+/);
  if (words.length > 6) {
    candidate = words.slice(0, 6).join(" ");
  }

  return toTitleCase(candidate);
}

function detectCategory(text: string): ExtractedItem["category"] {
  const lower = text.toLowerCase();

  const employmentScore = employmentSignals.reduce((acc, pattern) => (pattern.test(lower) ? acc + 1 : acc), 0);
  const appointmentScore = appointmentSignals.reduce((acc, pattern) => (pattern.test(lower) ? acc + 1 : acc), 0);

  // Hospital/doctor terms can appear in job adverts. Prioritize employment intent when strong.
  if (employmentScore >= 2 && employmentScore >= appointmentScore + 1) {
    return "JOB";
  }

  let winner: ExtractedItem["category"] = "OTHER";
  let winnerScore = 0;

  for (const category of ITEM_CATEGORIES) {
    if (category === "OTHER") {
      continue;
    }

    const hints = categoryHints[category] ?? [];
    const score = hints.reduce((acc, hint) => (lower.includes(hint) ? acc + 1 : acc), 0);
    if (score > winnerScore) {
      winner = category;
      winnerScore = score;
    }
  }

  return winner;
}

function parseDateIso(text: string): string | null {
  const datePatterns = [
    /\b(\d{4})-(\d{2})-(\d{2})\b/,
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
    /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/
  ];

  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }

    if (pattern === datePatterns[0]) {
      const isoDate = `${match[1]}-${match[2]}-${match[3]}`;
      const parsed = new Date(`${isoDate}T00:00:00.000Z`);
      if (!Number.isNaN(parsed.getTime())) {
        return isoDate;
      }
    } else {
      const day = Number(match[1]);
      const month = Number(match[2]);
      const year = Number(match[3]);
      const parsed = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString().slice(0, 10);
      }
    }
  }

  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december"
  ];
  const monthPattern = new RegExp(`\\b(\\d{1,2})\\s+(${monthNames.join("|")})\\s+(\\d{4})\\b`, "i");
  const monthMatch = text.match(monthPattern);
  if (monthMatch) {
    const day = Number(monthMatch[1]);
    const monthNameRaw = monthMatch[2];
    const monthName = typeof monthNameRaw === "string" ? monthNameRaw.toLowerCase() : "";
    const monthIndex = monthNames.findIndex((month) => month === monthName);
    const year = Number(monthMatch[3]);
    if (monthIndex >= 0) {
      const parsed = new Date(Date.UTC(year, monthIndex, day, 0, 0, 0));
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString().slice(0, 10);
      }
    }
  }

  return null;
}

function parseContactMetadata(text: string, title: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch) {
    metadata.contactEmail = emailMatch[0];
  }

  const phoneMatch = text.match(/\+?\d[\d\s()-]{7,}\d/);
  if (phoneMatch) {
    metadata.contactPhone = phoneMatch[0].trim();
  }

  const websiteMatch = text.match(/https?:\/\/[^\s]+/i);
  if (websiteMatch) {
    metadata.website = websiteMatch[0].replace(/[.,;:!?)]*$/g, "");
  }

  const companyFromTitle = title.match(/^([A-Z][A-Za-z0-9&.-]+)/)?.[1];
  if (companyFromTitle) {
    metadata.company = companyFromTitle;
  } else if (typeof metadata.website === "string") {
    const domainMatch = metadata.website.match(/^https?:\/\/(?:www\.)?([a-z0-9-]+)/i);
    if (domainMatch?.[1]) {
      metadata.company = toTitleCase(domainMatch[1]);
    }
  }

  return metadata;
}

export type HeuristicExtractionResult = {
  extracted: ExtractedItem;
  confidence: number;
  completenessScore: number;
};

export class TextExtractor {
  extract(ocrText: string): HeuristicExtractionResult {
    const normalized = ocrText.trim();
    const title = deriveTitle(normalized);
    const category = detectCategory(normalized);
    const deadline = parseDateIso(normalized);
    const metadata = parseContactMetadata(normalized, title);

    const extracted: ExtractedItem = {
      title,
      summary: "Pending Gemini summary",
      category,
      deadline,
      eventDate: null,
      state: "READY",
      metadata
    };

    let score = 0;
    if (title !== "Untitled Item") score += 0.3;
    if (category !== "OTHER") score += 0.2;
    if (deadline !== null) score += 0.2;
    if (Object.keys(metadata).length > 0) score += 0.15;
    if (normalized.length > 80) score += 0.15;

    const confidence = Math.min(1, score);

    return {
      extracted,
      confidence,
      completenessScore: confidence
    };
  }
}
