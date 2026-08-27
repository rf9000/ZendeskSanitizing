import { franc } from "franc";
import type { Lang } from "./types.ts";

const ISO3_TO_LANG: Record<string, Lang> = { dan: "da", eng: "en", deu: "de" };
const MIN_LENGTH = 20;

export function detectLang(text: string): Lang {
  if (text.trim().length < MIN_LENGTH) return "en";
  const code = franc(text, { only: Object.keys(ISO3_TO_LANG), minLength: MIN_LENGTH });
  return ISO3_TO_LANG[code] ?? "en";
}
