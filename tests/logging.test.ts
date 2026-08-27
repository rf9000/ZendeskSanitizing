import { describe, expect, test } from "bun:test";
import { createLogger, formatCounts, redactionGuard } from "@/logging.ts";
import { emptyCounts } from "@/sanitize/types.ts";

describe("redactionGuard", () => {
  test("redacts email, CPR and IBAN shapes", () => {
    const { line, hit } = redactionGuard("user mette@example.dk cpr 010190-1234 iban DK5000400440116243 done");
    expect(line).toBe("user <redacted> cpr <redacted> iban <redacted> done");
    expect(hit).toBe(true);
  });
  test("leaves clean lines alone", () => {
    expect(redactionGuard("ticket 12345: PERSON 3, EMAIL 2")).toEqual({ line: "ticket 12345: PERSON 3, EMAIL 2", hit: false });
  });
});

describe("createLogger", () => {
  test("filters by level, prefixes level, applies guard and counts hits", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", sink: (l) => lines.push(l) });
    log.debug("hidden");
    log.info("ticket 1: ok");
    log.warn("leak mette@example.dk");
    expect(lines).toEqual(["[info] ticket 1: ok", "[warn] leak <redacted>"]);
    expect(log.guardHits()).toBe(1);
  });
});

describe("formatCounts", () => {
  test("omits zeros and orders by entity type", () => {
    const c = emptyCounts(); c.EMAIL = 2; c.PERSON = 3;
    expect(formatCounts(c)).toBe("PERSON 3, EMAIL 2");
    expect(formatCounts(emptyCounts())).toBe("none");
  });
});
