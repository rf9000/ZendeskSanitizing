import { describe, expect, test } from "bun:test";
import { createResultSanitizer, decodeText, encodeText } from "@/policy/resultSanitizer.ts";
import { SanitizeSession } from "@/sanitize/session.ts";
import { emptyAllowlist, fakePass1, spansByLiteral } from "../helpers/fakes.ts";
import fixture from "../fixtures/tickets/basic-da.json";

const payload = (({ expected, ...rest }) => rest)(fixture as any);

const newSession = () => new SanitizeSession({
  pass1: fakePass1((c) => spansByLiteral(c.text, [["Mette Sørensen", "PERSON"], ["mette@contoso.example", "EMAIL"], ["010190-1234", "CPR"], ["Contoso ApS", "ORG"]], "presidio")),
  pass2: null, allowlist: emptyAllowlist(), detectLang: () => "da",
  timeouts: { pass1Ms: 1000, pass2Ms: 1000 }, chunkMaxChars: 6000, concurrency: 2,
});

describe("decodeText / encodeText", () => {
  test("plain JSON", () => {
    const d = decodeText('{\n  "a": 1\n}');
    expect(d.prefix).toBe(""); expect(d.json).toEqual({ a: 1 });
  });
  test("prefixed JSON", () => {
    const d = decodeText('Ticket updated successfully!\n\n{"a":1}');
    expect(d.prefix).toBe("Ticket updated successfully!\n\n"); expect(d.json).toEqual({ a: 1 });
    expect(encodeText(d.prefix, d.json)).toBe('Ticket updated successfully!\n\n{\n  "a": 1\n}');
  });
  test("non-JSON", () => {
    const d = decodeText("🔍 Not Found: no such ticket 99");
    expect(d.json).toBeUndefined(); expect(d.raw).toBe("🔍 Not Found: no such ticket 99");
  });
  test("JSON array", () => {
    expect(decodeText("[1,2]").json).toEqual([1, 2]);
  });
});

describe("createResultSanitizer", () => {
  test("sanitizes JSON payloads field-by-field with consistent placeholders", async () => {
    const rs = createResultSanitizer({ newSession });
    const { result, counts } = await rs.sanitize({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
    const text = (result.content[0] as any).text as string;
    const out = JSON.parse(text);
    expect(out.ticket.subject).toBe("Faktura fra [PERSON_1] bliver ikke læst");
    expect(out.ticket.description).toContain("[PERSON_1] fra [ORG_1]. Mit cpr er [CPR_1].");
    expect(out.ticket.requester).toEqual({ id: 900001 });
    // Filenames are tokenized for detection: "faktura_MetteSørensen" -> "faktura Mette Sørensen",
    // so this fake (which matches the literal "Mette Sørensen") now catches it too.
    expect(out.comments[0].attachments[0].file_name).toBe("faktura_[PERSON_1].pdf");
    expect(text).not.toContain("mette@contoso.example");
    expect(text).not.toContain("content_url");
    expect(counts.PERSON).toBeGreaterThanOrEqual(2);
  });

  test("filename-embedded names are redacted; clean filenames come back byte-identical", async () => {
    const rs = createResultSanitizer({ newSession });
    const payload = {
      attachments: [
        { id: 1, file_name: "faktura_MetteSørensen.pdf", content_type: "application/pdf" },
        { id: 2, file_name: "rapport-2024.pdf", content_type: "application/pdf" },
      ],
    };
    const { result } = await rs.sanitize({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
    const out = JSON.parse((result.content[0] as any).text);
    expect(out.attachments[0].file_name).toBe("faktura_[PERSON_1].pdf");
    expect(out.attachments[1].file_name).toBe("rapport-2024.pdf");
  });

  test("non-JSON text is sanitized whole", async () => {
    const rs = createResultSanitizer({ newSession });
    const { result } = await rs.sanitize({ content: [{ type: "text", text: "Error for Mette Sørensen: not found" }], isError: true, validationDetails: { raw: "Mette Sørensen" } });
    expect((result.content[0] as any).text).toBe("Error for [PERSON_1]: not found");
    expect(result.isError).toBe(true);
    expect((result as any).validationDetails).toBeUndefined();
  });

  test("a free-text prefix before the JSON is sanitized too", async () => {
    const rs = createResultSanitizer({ newSession });
    const { result } = await rs.sanitize({ content: [{ type: "text", text: 'Validation Error: requester Mette Sørensen not found\n\nDetails:\n{"requester":"Mette Sørensen"}' }], isError: true });
    const text = (result.content[0] as any).text as string;
    expect(text).toBe('Validation Error: requester [PERSON_1] not found\n\nDetails:\n{\n  "requester": "[PERSON_1]"\n}');
  });

  test("multiple content items share one placeholder table", async () => {
    const rs = createResultSanitizer({ newSession });
    const { result } = await rs.sanitize({ content: [{ type: "text", text: "Mette Sørensen" }, { type: "text", text: "Again Mette Sørensen" }] });
    expect((result.content[1] as any).text).toBe("Again [PERSON_1]");
  });

  test("non-text content items are dropped", async () => {
    const rs = createResultSanitizer({ newSession });
    const { result } = await rs.sanitize({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "ok" }] });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("empty-string fields do not fail the whole call", async () => {
    const newSessionThrowsOnEmpty = () => new SanitizeSession({
      pass1: fakePass1((c) => {
        if (c.text.length === 0) throw new Error("must not be called for empty text");
        return spansByLiteral(c.text, [["x", "PERSON"]], "presidio");
      }),
      pass2: null, allowlist: emptyAllowlist(),
      timeouts: { pass1Ms: 1000, pass2Ms: 1000 }, chunkMaxChars: 6000, concurrency: 2,
    });
    const rs = createResultSanitizer({ newSession: newSessionThrowsOnEmpty });
    const { result } = await rs.sanitize({ content: [{ type: "text", text: JSON.stringify({ ticket: { subject: "x", raw_subject: "" } }, null, 2) }] });
    const out = JSON.parse((result.content[0] as any).text);
    expect(out.ticket.raw_subject).toBe("");
  });

  test("sanitizer failure propagates (caller maps to MCP error)", async () => {
    const failing = () => new SanitizeSession({
      pass1: fakePass1(() => { throw new Error("down"); }), pass2: null, allowlist: emptyAllowlist(),
      timeouts: { pass1Ms: 10, pass2Ms: 10 }, chunkMaxChars: 6000, concurrency: 1,
    });
    const rs = createResultSanitizer({ newSession: failing });
    await expect(rs.sanitize({ content: [{ type: "text", text: "secret Mette" }] })).rejects.toThrow();
  });
});
