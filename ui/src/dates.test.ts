import { describe, expect, it } from "vitest";

import { formatEnglishDate } from "./dates";

describe("English date formatting", () => {
  it.each([
    ["2026-08-01T13:08:00.000Z", "August 1st, 2026"],
    ["2026-08-02T13:08:00.000Z", "August 2nd, 2026"],
    ["2026-08-03T13:08:00.000Z", "August 3rd, 2026"],
    ["2026-08-04T13:08:00.000Z", "August 4th, 2026"],
    ["2026-08-11T13:08:00.000Z", "August 11th, 2026"],
    ["2026-08-12T13:08:00.000Z", "August 12th, 2026"],
    ["2026-08-13T13:08:00.000Z", "August 13th, 2026"],
    ["2026-08-21T13:08:00.000Z", "August 21st, 2026"]
  ])("formats %s with the correct ordinal", (value, expected) => {
    expect(formatEnglishDate(value, { timeZone: "UTC" })).toBe(expected);
  });

  it("adds a local-style time when requested", () => {
    expect(formatEnglishDate("2026-08-17T13:08:00.000Z", { includeTime: true, timeZone: "UTC" })).toBe("August 17th, 2026 at 1:08 PM");
  });

  it("handles invalid timestamps without leaking an invalid date", () => {
    expect(formatEnglishDate("not-a-date")).toBe("Unknown date");
  });
});
