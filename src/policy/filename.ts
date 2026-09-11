/** Filename tokenization helpers so embedded names (e.g. `faktura_MetteSørensen.pdf`) get
 *  word-boundary spacing before being handed to the PII detectors, without ever sending a
 *  rewritten filename to a detector on its own — only the detection text is derived; the
 *  actual redaction/rejoin decision is made by the caller (`resultSanitizer.ts`). */

/** Splits a filename into `stem` and `ext`. `ext` is the last `.` plus everything after it,
 *  but only when that dot is neither the first character (dotfiles like `.gitignore` have no
 *  extension) nor the last character (a trailing dot is not a separator either). */
export function splitFilename(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return { stem: name, ext: "" };
  return { stem: name.slice(0, i), ext: name.slice(i) };
}

const SEPARATOR_RUN = /[_\-.\s]+/;
const CAMEL_BOUNDARY = /(?<=\p{Ll})(?=\p{Lu})/u;

/** Splits a stem on separator runs and camelCase boundaries (Unicode-aware, so `ø`/`Ø`,
 *  `å`/`Å`, `ä`/`Ä` etc. are handled), drops empty pieces and joins with single spaces. */
export function toDetectionText(stem: string): string {
  const pieces = stem
    .split(SEPARATOR_RUN)
    .flatMap((piece) => piece.split(CAMEL_BOUNDARY))
    .filter((piece) => piece.length > 0);
  return pieces.join(" ");
}

/** Rejoins sanitized detection text back into a filename: whitespace runs collapse to a
 *  single `_`, the result is trimmed, and the original extension is appended. */
export function rejoinFilename(sanitizedDetection: string, ext: string): string {
  return sanitizedDetection.trim().replace(/\s+/g, "_") + ext;
}
