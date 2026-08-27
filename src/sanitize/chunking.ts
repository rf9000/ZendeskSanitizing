const BOUNDARIES: RegExp[] = [/\n\n/g, /\n/g, /[.!?] /g, / /g];

function lastBoundaryBefore(window: string, re: RegExp): number {
  let last = -1;
  for (const m of window.matchAll(re)) {
    const end = m.index + m[0].length;
    if (end < window.length) last = end; // boundary must leave something after it
  }
  return last;
}

export function splitText(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError(`splitText: maxChars must be a positive integer, got ${maxChars}`);
  }
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1); // +1 so a boundary exactly at maxChars is seen
    let cut = -1;
    for (const re of BOUNDARIES) {
      cut = lastBoundaryBefore(window, re);
      if (cut > 0 && cut <= maxChars) break;
      cut = -1;
    }
    if (cut <= 0) cut = maxChars; // hard cut
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}
