import { describe, expect, test } from "bun:test";
import { applyFieldPolicy, fillFields, ruleFor } from "@/policy/fieldPolicy.ts";
import fixture from "../fixtures/tickets/basic-da.json";

const payload = (({ expected, expectedPass2, ...rest }) => rest)(fixture as any);

describe("ruleFor", () => {
  test("suffix rules skip array indices", () => {
    expect(ruleFor(["ticket", "comments", "3", "via", "source", "from"], {})).toBe("drop");
    expect(ruleFor(["ticket", "comments", "0", "html_body"], "<p>")).toBe("drop");
    expect(ruleFor(["comments", "0", "attachments", "0", "content_url"], "https://x")).toBe("drop");
    expect(ruleFor(["ticket", "requester"], { id: 1 })).toBe("idOnly");
  });
  test("defaults: string → sanitize, primitives → keep", () => {
    expect(ruleFor(["ticket", "some_new_field"], "text")).toBe("sanitize");
    expect(ruleFor(["ticket", "some_new_field"], 5)).toBe("keep");
    expect(ruleFor(["ticket", "some_new_field"], null)).toBe("keep");
  });
  test("known safe strings are kept", () => {
    for (const k of ["url", "status", "priority", "created_at", "updated_at", "content_type", "channel", "type", "next_page"]) {
      expect(ruleFor(["ticket", k], "x")).toBe("keep");
    }
  });
});

describe("applyFieldPolicy + fillFields", () => {
  test("drops, reduces and collects exactly the free-text fields", () => {
    const { skeleton, fields } = applyFieldPolicy(payload) as any;
    const t = skeleton.ticket;
    expect(t.requester).toEqual({ id: 900001 });
    expect(t.via.source.from).toBeUndefined();
    expect(t.via.channel).toBe("email");
    expect(t.metadata.system.ip_address).toBeUndefined();
    expect(t.metadata.system.location).toBeUndefined();
    expect(skeleton.comments[0].html_body).toBeUndefined();
    expect(skeleton.comments[0].attachments[0].content_url).toBeUndefined();
    expect(skeleton.comments[0].attachments[0].size).toBe(12345);
    expect(t.custom_fields[2].value).toBe(42);

    const paths = fields.map((f: any) => f.path).sort();
    expect(paths).toEqual([
      "comments.0.attachments.0.file_name", "comments.0.body", "comments.0.plain_body",
      "comments.1.body", "comments.1.plain_body",
      "ticket.custom_fields.0.value", "ticket.description", "ticket.raw_subject", "ticket.subject",
      "ticket.tags.0", "ticket.tags.1",
    ]);
  });

  test("fillFields swaps markers for sanitized text", () => {
    const { skeleton, fields } = applyFieldPolicy(payload);
    const texts = new Map(fields.map((f) => [f.path, `S(${f.path})`]));
    const filled = fillFields(skeleton, texts) as any;
    expect(filled.ticket.subject).toBe("S(ticket.subject)");
    expect(filled.comments[1].body).toBe("S(comments.1.body)");
    expect(JSON.stringify(filled)).not.toContain("__zsan");
  });

  test("fillFields throws if a marker is unfilled (fail closed)", () => {
    const { skeleton } = applyFieldPolicy(payload);
    expect(() => fillFields(skeleton, new Map())).toThrow(/unfilled/);
  });

  test("non-object payloads pass through", () => {
    expect(applyFieldPolicy(5)).toEqual({ skeleton: 5, fields: [] });
    const s = applyFieldPolicy("free text");
    expect(s.fields).toEqual([{ path: "", text: "free text" }]);
    expect(fillFields(s.skeleton, new Map([["", "X"]]))).toBe("X");
  });
});

describe("applyFieldPolicy fix round 1", () => {
  test("search-result user objects are reduced to { id, result_type }", () => {
    const { skeleton, fields } = applyFieldPolicy({
      results: [
        { result_type: "user", id: 7, name: "Lars Nielsen", email: "lars@x.example" },
        { result_type: "ticket", id: 1, subject: "Hej" },
      ],
      count: 2,
    }) as any;
    expect(skeleton.results[0]).toEqual({ id: 7, result_type: "user" });
    expect(skeleton.results[1]).toHaveProperty("subject");
    expect(fields.some((f: any) => f.path.startsWith("results.0"))).toBe(false);
  });

  test("idOnly applied to an array maps each element to { id } or null", () => {
    const { skeleton, fields } = applyFieldPolicy({
      ticket: { collaborators: [{ id: 1, name: "A", email: "a@x" }, { id: 2, name: "B" }] },
    }) as any;
    expect(skeleton.ticket.collaborators).toEqual([{ id: 1 }, { id: 2 }]);
    expect(JSON.stringify(skeleton)).not.toContain("A");
    expect(JSON.stringify(skeleton)).not.toContain("a@x");
    expect(JSON.stringify(skeleton)).not.toContain("B");
    expect(fields).toEqual([]);
  });

  test("marker robustness: numeric __zsan upstream is dropped, string markers still fill", () => {
    const { skeleton, fields } = applyFieldPolicy({ a: { __zsan: 5 }, b: "x" });
    expect((skeleton as any).a).toEqual({});
    const texts = new Map(fields.map((f) => [f.path, `S(${f.path})`]));
    const filled = fillFields(skeleton, texts) as any;
    expect(filled.b).toBe("S(b)");
    expect(JSON.stringify(filled)).not.toContain("__zsan");
  });
});
