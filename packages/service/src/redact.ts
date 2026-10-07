export const MASK = "********";
// Shorter values would mask ordinary text; the approver is told which ones stay visible.
export const MIN_HIDDEN = 4;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The forms a stored value is likely to be printed in: as stored, URL-encoded, base64 and JSON-escaped. */
export function forms(value: string): string[] {
  const base64 = Buffer.from(value, "utf8").toString("base64");
  return [value, encodeURIComponent(value), base64, base64.replace(/=+$/, ""), JSON.stringify(value).slice(1, -1)].filter(form => form.length >= MIN_HIDDEN);
}
export class Redactor {
  private pattern: RegExp | undefined; private longest: number;
  constructor(values: string[]) {
    // Longest first, so a value that contains another is masked whole.
    const all = [...new Set(values.filter(value => value.length >= MIN_HIDDEN).flatMap(forms))].sort((a, b) => b.length - a.length);
    this.longest = all[0]?.length ?? 0; this.pattern = all.length ? new RegExp(all.map(escape).join("|"), "g") : undefined;
  }
  all(text: string) { return this.pattern ? text.replace(this.pattern, MASK) : text; }
  /** Masks a stream that arrives in pieces: text is let out only once nothing after it can complete a stored value. */
  stream() {
    let tail = "";
    return {
      push: (text: string) => {
        const pattern = this.pattern; if (!pattern) return text;
        const buffer = tail + text; let cut = Math.max(0, buffer.length - this.longest + 1), out = "", index = 0, match;
        // A value that starts before the cut ends inside the buffer, so every match found there is complete.
        pattern.lastIndex = 0;
        while ((match = pattern.exec(buffer)) && match.index < cut) { out += buffer.slice(index, match.index) + MASK; index = match.index + match[0].length; cut = Math.max(cut, index); }
        out += buffer.slice(index, cut); tail = buffer.slice(cut); return out;
      },
      end: () => { const rest = this.all(tail); tail = ""; return rest; },
    };
  }
}
