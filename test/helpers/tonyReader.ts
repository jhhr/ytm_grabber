// A test oracle: reads TTML by the rules of Tony's parseTtml() (main/LyricsTtml.cpp in
// jhhr/tony, PLAN.md section 1.6). Deliberately small, and written apart from
// src/shared/ttml.ts so that a writer bug cannot hide in shared code. The XML side is a
// strict little tokenizer for the shape lyrics TTML has (no DTD, no entities beyond the five
// and character references): what it cannot read, it throws on, as Qt's reader would.
//
// Modelled: absolute times in m:ss.mmm, mm:ss.mmm, h:mm:ss.mmm and plain seconds, plus `dur`;
// timed spans with nothing but text between them are one word, white space between them
// separates words; spans whose ttm:role is x-bg, x-translation, x-roman or x-romanization are
// skipped (and separate words); untimed spans are wrappers; a <p> without timed spans is one
// line-long word; a <head> <title> is the title; words sorted by start in a line, lines by
// their first start; refusal of a DOCTYPE, of more than 1 MiB and of a file with no words.
// Not modelled: offset times such as "12s", ends Tony infers for words without one (they
// stay undefined here), the 200-character cut of a word, and Tony's warnings.

export interface TonyWord {
  text: string;
  /** Seconds. */
  begin: number;
  /** Seconds; undefined where the file gives no end. */
  end: number | undefined;
}

export interface TonyLine {
  words: TonyWord[];
}

export interface TonyLyrics {
  title: string;
  lines: TonyLine[];
  /** Spans left out for their role. */
  skippedParts: number;
}

const MAX_BYTES = 1024 * 1024;
const SKIPPED_ROLES = new Set(["x-bg", "x-translation", "x-roman", "x-romanization"]);
const NOT_XML_CHAR = /[^\t\n\r\x20-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/u;
const NAME = "[A-Za-z_][-A-Za-z0-9._:]*";
const START_TAG = new RegExp(`<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`, "y");
const END_TAG = new RegExp(`</(${NAME})\\s*>`, "y");
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const ATTRIBUTE = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "g");

interface Element {
  /** Local name: Tony matches elements and attributes in any namespace. */
  name: string;
  attributes: Map<string, string>;
  children: (Element | string)[];
}

/** Throws with the reason Tony would give for refusing the file. */
export function readTony(ttml: string): TonyLyrics {
  if (ttml === "") throw new Error("empty file");
  if (new TextEncoder().encode(ttml).length > MAX_BYTES) throw new Error("over 1 MiB");
  const root = parseXml(ttml);

  const state: TonyLyrics = { title: "", lines: [], skippedParts: 0 };
  const visit = (element: Element, inHead: boolean): void => {
    for (const child of element.children) {
      if (typeof child === "string") continue;
      if (child.name === "head") visit(child, true);
      else if (inHead && child.name === "title" && state.title === "") state.title = label(collapse(textContent(child)));
      else if (!inHead && child.name === "p") readParagraph(child, state);
      else visit(child, inHead);
    }
  };
  visit({ name: "", attributes: new Map(), children: [root] }, false);

  if (state.lines.length === 0) throw new Error("no timed lyrics");
  state.lines = stableSortBy(state.lines, (line) => line.words[0].begin);
  return state;
}

// ---- Tony's reading of a <p> ----

type Piece = { kind: "timed"; text: string; begin: number; end: number | undefined } | { kind: "text"; text: string } | { kind: "blank" };

function readParagraph(p: Element, state: TonyLyrics): void {
  const timing = readTiming(p);
  const pieces: Piece[] = [];
  readInline(p, pieces, state);

  if (!pieces.some((piece) => piece.kind === "timed")) {
    const text = label(collapse(pieces.map((piece) => (piece.kind === "blank" ? " " : piece.text)).join("")));
    if (text !== "" && timing.begin !== undefined) state.lines.push({ words: [{ text, begin: timing.begin, end: timing.end }] });
    return;
  }

  const words: TonyWord[] = [];
  let current: TonyWord | undefined;
  const finish = () => {
    if (current) {
      current.text = label(current.text.replace(/[ \t\n\r]/g, " "));
      if (current.text !== "") words.push(current);
    }
    current = undefined;
  };
  for (const piece of pieces) {
    if (piece.kind === "blank") finish();
    else if (piece.kind === "timed") {
      if (current) {
        current.text += piece.text;
        current.end = piece.end;
      } else current = { text: piece.text, begin: piece.begin, end: piece.end };
    } else if (current) current.text += piece.text; // text outside a word is dropped
  }
  finish();
  if (words.length > 0) state.lines.push({ words: stableSortBy(words, (word) => word.begin) });
}

function readInline(element: Element, pieces: Piece[], state: TonyLyrics): void {
  for (const child of element.children) {
    if (typeof child === "string") {
      for (const run of child.match(/[ \t\n\r]+|[^ \t\n\r]+/g) ?? []) {
        const last = pieces.at(-1);
        if (isSpace(run[0])) addBlank(pieces);
        else if (last?.kind === "text") last.text += run;
        else pieces.push({ kind: "text", text: run });
      }
    } else if (child.name === "br") addBlank(pieces);
    else if (child.name !== "span") continue;
    else if (hasSkippedRole(child)) {
      state.skippedParts++;
      addBlank(pieces);
    } else {
      const timing = readTiming(child);
      if (!timing.hasBegin) {
        readInline(child, pieces, state);
        continue;
      }
      const text = allText(child, state);
      if (timing.begin === undefined) {
        addBlank(pieces); // a word whose begin cannot be read is left out
        continue;
      }
      if (text !== "" && isSpace(text[0])) addBlank(pieces);
      pieces.push({ kind: "timed", text: text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, ""), begin: timing.begin, end: timing.end });
      if (text !== "" && isSpace(text[text.length - 1])) addBlank(pieces);
    }
  }
}

/** Tony's readAllText: text of nested spans included, <br/> and skipped spans a space, other elements nothing. */
function allText(element: Element, state: TonyLyrics): string {
  let text = "";
  for (const child of element.children) {
    if (typeof child === "string") text += child;
    else if (child.name === "br") text += " ";
    else if (child.name !== "span") continue;
    else if (hasSkippedRole(child)) {
      state.skippedParts++;
      text += " ";
    } else text += allText(child, state);
  }
  return text;
}

/** All the text inside, as Qt's readElementText(IncludeChildElements) gives it for the title. */
function textContent(element: Element): string {
  return element.children.map((child) => (typeof child === "string" ? child : textContent(child))).join("");
}

function addBlank(pieces: Piece[]): void {
  if (pieces.at(-1)?.kind !== "blank") pieces.push({ kind: "blank" });
}

function readTiming(element: Element): { hasBegin: boolean; begin: number | undefined; end: number | undefined } {
  const beginText = element.attributes.get("begin");
  const begin = beginText === undefined ? undefined : readTime(beginText);
  let end = element.attributes.has("end") ? readTime(element.attributes.get("end")!) : undefined;
  const dur = element.attributes.get("dur");
  if (end === undefined && dur !== undefined && begin !== undefined) {
    const length = readTime(dur);
    if (length !== undefined) end = begin + length;
  }
  return { hasBegin: beginText !== undefined, begin, end };
}

/** [[h:]m:]s[.fraction]: minutes and seconds below 60 where something bigger comes before them. */
function readTime(text: string): number | undefined {
  const match = /^(\d+)(?::(\d+))?(?::(\d+))?(?:\.(\d+))?$/.exec(text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, ""));
  if (!match) return undefined;
  const [, a, b, c, fraction = ""] = match;
  const fields = [a, b, c].filter((field) => field !== undefined).map(Number);
  const [hours, minutes, seconds] = fields.length === 3 ? fields : fields.length === 2 ? [0, ...fields] : [0, 0, ...fields];
  if (fields.length > 1 && seconds >= 60) return undefined;
  if (fields.length === 3 && minutes >= 60) return undefined;
  const scale = 10 ** fraction.length;
  return (((hours * 60 + minutes) * 60 + seconds) * scale + Number(fraction || 0)) / scale;
}

function hasSkippedRole(element: Element): boolean {
  return (element.attributes.get("role") ?? "").split(" ").some((role) => SKIPPED_ROLES.has(role));
}

/** Tony's lyricsLabel(): tab a space, other controls (and U+FFFE/U+FFFF) out, trimmed. */
function label(text: string): string {
  return text
    .replace(/\t/g, " ")
    .replace(/[\x00-\x1f\x7f\u{FFFE}\u{FFFF}]/gu, "")
    .trim();
}

/** Every run of XML white space one space, none at either end. */
function collapse(text: string): string {
  return text.split(/[ \t\n\r]+/).filter(Boolean).join(" ");
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function stableSortBy<T>(items: T[], key: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => key(x.item) - key(y.item) || x.index - y.index)
    .map(({ item }) => item);
}

// ---- XML ----

function parseXml(source: string): Element {
  // Line ends as an XML parser normalises them; a BOM is not content.
  const text = source.replace(/^\u{FEFF}/u, "").replace(/\r\n?/g, "\n");
  if (NOT_XML_CHAR.test(text)) throw new Error("not well-formed: a character XML 1.0 does not allow");
  const stack: Element[] = [];
  let root: Element | undefined;
  let pos = 0;
  while (pos < text.length) {
    if (text.startsWith("<!DOCTYPE", pos)) throw new Error("has a DOCTYPE");
    if (text.startsWith("<?", pos) || text.startsWith("<!--", pos)) {
      const close = text.indexOf(text[pos + 1] === "?" ? "?>" : "-->", pos + 2);
      if (close < 0) throw new Error("not well-formed: unclosed declaration or comment");
      pos = close + (text[pos + 1] === "?" ? 2 : 3);
      continue;
    }
    if (text.startsWith("<![CDATA[", pos)) {
      const close = text.indexOf("]]>", pos);
      if (close < 0 || stack.length === 0) throw new Error("not well-formed: CDATA");
      stack[stack.length - 1].children.push(text.slice(pos + 9, close));
      pos = close + 3;
      continue;
    }
    if (text.startsWith("</", pos)) {
      END_TAG.lastIndex = pos;
      const match = END_TAG.exec(text);
      const open = stack.pop();
      if (!match || !open || localName(match[1]) !== open.name) throw new Error(`not well-formed: end tag at ${pos}`);
      pos = END_TAG.lastIndex;
      continue;
    }
    if (text[pos] === "<") {
      START_TAG.lastIndex = pos;
      const match = START_TAG.exec(text);
      if (!match || (root && stack.length === 0)) throw new Error(`not well-formed: tag at ${pos}`);
      const element: Element = { name: localName(match[1]), attributes: readAttributes(match[2]), children: [] };
      if (stack.length > 0) stack[stack.length - 1].children.push(element);
      else root = element;
      if (match[3] !== "/") stack.push(element);
      pos = START_TAG.lastIndex;
      continue;
    }
    const next = text.indexOf("<", pos);
    const raw = text.slice(pos, next < 0 ? text.length : next);
    if (stack.length > 0) stack[stack.length - 1].children.push(decode(raw));
    else if (raw.trim() !== "") throw new Error("not well-formed: text outside the root element");
    pos += raw.length;
  }
  if (!root || stack.length > 0) throw new Error("not well-formed: no root element, or one left open");
  return root;
}

function readAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, name, double, single] of text.matchAll(ATTRIBUTE)) {
    if (name === "xmlns" || name.startsWith("xmlns:")) continue;
    const key = localName(name);
    if (attributes.has(key)) continue; // Tony takes the first
    // Attribute-value normalisation: literal white space becomes a space before references are expanded.
    attributes.set(key, decode((double ?? single).replace(/[\t\n\r]/g, " ")));
  }
  return attributes;
}

function decode(text: string): string {
  return text.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9A-Fa-f]+));|&/g, (whole, named, decimal, hex) => {
    if (named) return NAMED_ENTITIES[named];
    if (decimal === undefined && hex === undefined) throw new Error("not well-formed: a bare &");
    const code = decimal !== undefined ? Number(decimal) : parseInt(hex, 16);
    const char = code <= 0x10ffff ? String.fromCodePoint(code) : "";
    if (char === "" || NOT_XML_CHAR.test(char)) throw new Error(`not well-formed: ${whole}`);
    return char;
  });
}

function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}
