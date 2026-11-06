/** Text from HTML, without a parser: search reads documents with it, and connectors read mail. */

const HIDDEN_ELEMENTS = ["script", "style", "head"].map((tag) =>
  element(tag, "gi")
);

/** The visible text of an HTML page. */
export function htmlText(html: string): string {
  return entities(
    HIDDEN_ELEMENTS.reduce((text, hidden) => text.replace(hidden, " "), html)
      .replace(/<\/(p|div|li|h\d|tr|br)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^<>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** The elements `<tag …>…</tag>`; the first group is the content. */
export function element(tag: string, flags = "g"): RegExp {
  return new RegExp(`<${tag}\\b[^<>]*>(${withoutTag(tag)})<\\/${tag}>`, flags);
}

/** Any text without `<tag` or `</tag`, so a missing end tag ends the match at the next start tag. */
export function withoutTag(tag: string): string {
  return `[^<]*(?:<(?!\\/?${tag}\\b)[^<]*)*`;
}

/** Text with its HTML entities decoded. */
export function entities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, number: string) =>
      String.fromCodePoint(Number(number))
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
