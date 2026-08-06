import { describe, expect, it } from "vitest";
import { sanitizeMetadata } from "../../src/domain/item.js";

describe("sanitizeMetadata", () => {
  it("removes disallowed keys for known category", () => {
    const sanitized = sanitizeMetadata("EVENT", {
      venue: "Main Hall",
      organiser: "Remindly",
      amount: 500,
      random: "nope"
    });

    expect(sanitized).toEqual({
      venue: "Main Hall",
      organiser: "Remindly"
    });
  });

  it("keeps custom only for OTHER category", () => {
    const sanitized = sanitizeMetadata("OTHER", {
      custom: { foo: "bar" },
      venue: "X"
    });

    expect(sanitized).toEqual({
      custom: { foo: "bar" }
    });
  });
});
