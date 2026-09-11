import { normalizeValue } from "./placeholders.ts";
import type { Span } from "./types.ts";

export class Allowlist {
  private readonly exact = new Set<string>();
  private readonly wordSets: Array<Set<string>> = [];
  private readonly termPatterns: RegExp[] = [];

  private constructor(terms: string[]) {
    for (const raw of terms) {
      const n = normalizeValue(raw);
      if (!n) continue;
      this.exact.add(n);
      const words = n.split(" ");
      if (words.length > 1) this.wordSets.push(new Set(words));

      const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&")).join("\\s+");
      this.termPatterns.push(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"));
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
    if (words.length === 0) return false;
    const qualifies = words.length >= 2 || /^[a-zæøåàâäéèêëíìîïóòôöúùûüß]{4,}$/i.test(words[0]!.normalize("NFC"));
    return qualifies && this.wordSets.some((set) => words.every((w) => set.has(w)));
  }

  filter(text: string, spans: Span[]): Span[] {
    return spans.filter((sp) => !this.isAllowed(text.slice(sp.start, sp.end)));
  }

  /** UTF-16 ranges of allowlisted terms in `text` (case-insensitive, whole words, whitespace-flexible), merged and sorted. */
  findOccurrences(text: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (const re of this.termPatterns) {
      for (const m of text.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged;
  }
}
