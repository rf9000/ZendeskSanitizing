import { readdir } from "node:fs/promises";
import { join } from "node:path";

const CPR_RE = /^(\d{2})(\d{2})(\d{2})-?(\d)(\d{3})$/;

function centuryFor(seventh: number, yy: number): number {
  if (seventh <= 3) return 1900;
  if (seventh === 4 || seventh === 9) return yy <= 36 ? 2000 : 1900;
  return yy <= 57 ? 2000 : 1800; // 5–8
}

export function isValidCpr(candidate: string): boolean {
  const m = CPR_RE.exec(candidate);
  if (!m) return false;
  const dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]), seventh = Number(m[4]);
  if (mm < 1 || mm > 12 || dd < 1) return false;
  const year = centuryFor(seventh, yy) + yy;
  const daysInMonth = new Date(Date.UTC(year, mm, 0)).getUTCDate(); // day 0 of next month
  return dd <= daysInMonth;
}

export interface AdHocRecognizer {
  name: string;
  supported_entity: string;
  patterns: Array<{ name: string; regex: string; score: number }>;
  context?: string[];
}

export async function loadRecognizers(dir: string): Promise<AdHocRecognizer[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(files.map(async (f) => (await Bun.file(join(dir, f)).json()) as AdHocRecognizer));
}
