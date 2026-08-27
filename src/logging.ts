import { ENTITY_TYPES, type Counts } from "./sanitize/types.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const GUARDS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,   // email
  /\b\d{6}-\d{4}\b/g,                                   // CPR with hyphen
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,                  // IBAN-shaped
];

export function redactionGuard(line: string): { line: string; hit: boolean } {
  let hit = false;
  let out = line;
  for (const re of GUARDS) {
    if (re.test(out)) { hit = true; out = out.replace(re, "<redacted>"); }
    re.lastIndex = 0;
  }
  return { line: out, hit };
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  guardHits(): number;
}

export function createLogger(opts: { level: LogLevel; sink?: (line: string) => void }): Logger {
  const sink = opts.sink ?? ((l: string) => process.stderr.write(l + "\n"));
  let hits = 0;
  const emit = (level: LogLevel, msg: string) => {
    if (ORDER[level] < ORDER[opts.level]) return;
    const { line, hit } = redactionGuard(msg);
    if (hit) hits++;
    sink(`[${level}] ${line}`);
  };
  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
    guardHits: () => hits,
  };
}

export function formatCounts(counts: Counts): string {
  const parts = ENTITY_TYPES.filter((t) => counts[t] > 0).map((t) => `${t} ${counts[t]}`);
  return parts.length ? parts.join(", ") : "none";
}
