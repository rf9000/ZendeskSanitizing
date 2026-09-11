/** Filename tokenization helpers so embedded names (e.g. `faktura_MetteSørensen.pdf`) get
 *  word-boundary spacing before being handed to the PII detectors, without ever sending a
 *  rewritten filename to a detector on its own — only the detection text is derived; the
 *  actual redaction/rejoin decision is made by the caller (`resultSanitizer.ts`). */

/** Extension is a short (1-8 char) run of plain ASCII letters/digits after the last dot, so a
 *  non-extension tail (e.g. a name with a space in it, `notat.Mette Sørensen`) never gets
 *  mistaken for one and smuggled past detection unanalyzed. */
const EXTENSION_RE = /\.[A-Za-z0-9]{1,8}$/;

/** Splits a filename into `stem` and `ext`. `ext` is matched by `EXTENSION_RE` at the end of
 *  the name; a dotfile with no such trailing token (e.g. `.gitignore`) or a name with no
 *  qualifying extension at all (e.g. `README`, `foo.`, `notat.Mette Sørensen`) has `ext: ""`. */
export function splitFilename(name: string): { stem: string; ext: string } {
  const m = EXTENSION_RE.exec(name);
  if (!m || m.index === 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, m.index), ext: m[0] };
}

const SEPARATOR_RUN = /[_\-.\s]+/;
const CAMEL_BOUNDARY = /(?<=\p{Ll})(?=\p{Lu})/u;
const DIGIT_LETTER_BOUNDARY = /(?<=\p{N})(?=\p{L})|(?<=\p{L})(?=\p{N})/u;

/** Splits a stem on separator runs, camelCase boundaries, and digit/letter boundaries
 *  (Unicode-aware, so `ø`/`Ø`, `å`/`Å`, `ä`/`Ä` etc. are handled), drops empty pieces and
 *  joins with single spaces. */
export function toDetectionText(stem: string): string {
  const pieces = stem
    .split(SEPARATOR_RUN)
    .flatMap((piece) => piece.split(CAMEL_BOUNDARY))
    .flatMap((piece) => piece.split(DIGIT_LETTER_BOUNDARY))
    .filter((piece) => piece.length > 0);
  return pieces.join(" ");
}

/** Rejoins sanitized detection text back into a filename: whitespace runs collapse to a
 *  single `_`, the result is trimmed, and the original extension is appended. */
export function rejoinFilename(sanitizedDetection: string, ext: string): string {
  return sanitizedDetection.trim().replace(/\s+/g, "_") + ext;
}
