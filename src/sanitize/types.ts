export type Lang = "da" | "en" | "de";

export const ENTITY_TYPES = ["PERSON", "ORG", "EMAIL", "PHONE", "CPR", "IBAN", "CARD", "ADDRESS", "USERNAME", "OTHER"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export type SpanSource = "presidio" | "gliner" | "ollama";

export interface Span {
  start: number;
  end: number; // exclusive
  type: EntityType;
  score: number;
  source: SpanSource;
}

export interface Chunk {
  id: string;
  text: string;
  lang?: Lang;
}

export interface Pass1Client {
  analyze(chunk: Chunk, opts: { signal: AbortSignal }): Promise<Span[]>;
}

export interface SpanDetector {
  readonly name: string;
  detect(chunk: Chunk, opts: { signal: AbortSignal }): Promise<Span[]>;
}

export type Counts = Record<EntityType, number>;
export function emptyCounts(): Counts {
  return Object.fromEntries(ENTITY_TYPES.map((t) => [t, 0])) as Counts;
}

export type SanitizerErrorCode = "SANITIZER_UNAVAILABLE" | "SANITIZER_INVALID_OUTPUT" | "SANITIZER_INTERNAL";

export class SanitizerError extends Error {
  readonly code: SanitizerErrorCode;
  constructor(code: SanitizerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SanitizerError";
    this.code = code;
  }
}
