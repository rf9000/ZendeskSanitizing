import { normalizeValue } from "./placeholders.ts";
import type { Span } from "./types.ts";

export class Allowlist {
  private readonly exact = new Set<string>();
  private readonly wordSets: Array<Set<string>> = [];

  private constructor(terms: string[]) {
    for (const raw of terms) {
      const n = normalizeValue(raw);
      if (!n) continue;
      this.exact.add(n);
      const words = n.split(" ");
      if (words.length > 1) this.wordSets.push(new Set(words));
    }
  }

  static fromText(content: string): Allowlist {
    const terms = content
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l.length > 0);
    return new Allowlist(terms);
  }

  static async fromFile(path: string): Promise<Allowlist> {
    return Allowlist.fromText(await Bun.file(path).text());
  }

  isAllowed(spanText: string): boolean {
    const n = normalizeValue(spanText);
    if (this.exact.has(n)) return true;
    const words = n.split(" ").filter((w) => w.length > 0);
    return words.length > 0 && this.wordSets.some((set) => words.every((w) => set.has(w)));
  }

  filter(text: string, spans: Span[]): Span[] {
    return spans.filter((sp) => !this.isAllowed(text.slice(sp.start, sp.end)));
  }
}
