// Parser for Better Lyrics' lyrics stream (POST lyrics.api.dacubeking.com/v2/lyrics, a
// text/event-stream response). It mirrors BL's own parseSSEMessage() (verified against
// Better Lyrics 3.0.0.4, src/modules/lyrics/providers/unified.ts) rule for rule, so we see
// exactly the events BL saw, including its quirks:
// - blocks are split on /\n\n|\r\n\r\n/ and lines on /\r?\n/;
// - only lines starting with "event:" or "data:" count (id:, retry: and ":" comment lines
//   are ignored), and the value is everything after the first ":", trimmed;
// - the last "event:" of a block wins; "data:" values are joined with no separator;
// - a block with no data, or with the data "[DONE]", is skipped.
// BL reads the stream in chunks and keeps the unterminated tail for the next chunk; for a
// complete text that is the same as splitting it whole (the tail is the last block).

export interface SseEvent {
  /** The block's last `event:` value; "" when it has none. */
  event: string;
  /** The parsed JSON data; null when it was not valid JSON (then error and rawData are set). */
  data: unknown;
  error?: string;
  rawData?: string;
}

const BLOCK_SEPARATOR = /\n\n|\r\n\r\n/;
const LINE_BREAK = /\r?\n/;

/** Never throws: a block whose data is not valid JSON comes back with `error` and `rawData`. */
export function parseSse(text: string): SseEvent[] {
  // BL decodes the bytes with TextDecoder, which drops a leading byte order mark.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const events: SseEvent[] = [];
  for (const block of text.split(BLOCK_SEPARATOR)) {
    const event = parseBlock(block);
    if (event) events.push(event);
  }
  return events;
}

function parseBlock(block: string): SseEvent | null {
  let event = "";
  let data = "";
  for (const line of block.split(LINE_BREAK)) {
    if (line.startsWith("event:")) event = line.substring(line.indexOf(":") + 1).trim();
    else if (line.startsWith("data:")) data += line.substring(line.indexOf(":") + 1).trim();
  }
  if (!data || data === "[DONE]") return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch (error) {
    return { event, data: null, error: error instanceof Error ? error.message : String(error), rawData: data };
  }
}
