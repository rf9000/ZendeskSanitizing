/**
 * Presidio (and Plan 2's GLiNER/Ollama clients) report entity offsets as Unicode code-point
 * indices; JavaScript strings index by UTF-16 code unit. Any character outside the Basic
 * Multilingual Plane (emoji, some CJK/symbol ranges) is one code point but two UTF-16 units,
 * so code-point offsets must be translated before they can be used with `String#slice`.
 */
export function codePointToUtf16Map(text: string): number[] {
  const map = [0];
  let u = 0;
  for (const ch of text) {
    u += ch.length;
    map.push(u);
  }
  return map; // map[cp] = utf16 index; map.length-1 = number of code points
}
