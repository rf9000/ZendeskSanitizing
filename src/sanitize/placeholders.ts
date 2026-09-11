import { ENTITY_TYPES, type EntityType } from "./types.ts";

// Shared /g instance: use matchAll/match only — never .test/.exec (stateful lastIndex).
export const PLACEHOLDER_RE = new RegExp(`\\[(${ENTITY_TYPES.join("|")})_\\d+\\]`, "g");

export function normalizeValue(value: string): string {
  return value.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

interface Entry {
  type: EntityType;
  normalized: string;
  words: Set<string>;
  placeholder: string;
}

function significantWords(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((w) => w.length >= 2));
}

export class PlaceholderTable {
  private readonly entries: Entry[] = [];
  private readonly counters = new Map<EntityType, number>();

  placeholderFor(type: EntityType, value: string): string {
    const normalized = normalizeValue(value);
    const exact = this.entries.find((e) => e.type === type && e.normalized === normalized);
    if (exact) return exact.placeholder;

    const words = significantWords(normalized);
    if (words.size > 0) {
      const superset = this.entries.find(
        (e) => e.type === type && [...words].every((w) => e.words.has(w)),
      );
      if (superset) return superset.placeholder;
    }

    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const placeholder = `[${type}_${n}]`;
    this.entries.push({ type, normalized, words, placeholder });
    return placeholder;
  }

  size(): number {
    return this.entries.length;
  }
}
