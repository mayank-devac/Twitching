// Splits a prompt into readable text plus structured attachments, so file paths and
// raw JSON wrappers never reach the timeline.
export interface PromptAnnotation {
  index: number;
  quote: string;
  comment: string;
}
export interface PromptReply {
  header?: string;
  question: string;
  answer: string;
}
export interface PromptFile {
  ext: string;
}
export interface PromptParts {
  body: string;
  annotations: PromptAnnotation[];
  replies: PromptReply[];
  files: PromptFile[];
}

// Fixed wording of Codex's bare annotation export, and how its JSON array begins.
const BARE_EXPORT_PREAMBLE = "Each item contains text selected";
const BARE_EXPORT_ARRAY = '[{"text"';
// The bare export's array always closes on an object; arrays ending otherwise stay as text.
const BARE_EXPORT_ARRAY_END = "}]";
// A pasted block may carry a caption before its array.
const PASTED_ARRAY = "[{";
const JSON_WHITESPACE = /^[ \t\n\r]*$/;

const str = (value: unknown) => (typeof value === "string" ? value : "");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const extOf = (name: string) =>
  (/\.([A-Za-z0-9]{1,8})$/.exec(name.trim())?.[1] ?? "file").toUpperCase();
const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

function json(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

// Index just past the bracket closing the array opened at `start`, found in one
// string-aware pass, or -1 when it never closes. Only valid JSON is trusted afterwards.
function arrayEnd(source: string, start: number) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "[" || char === "{") depth++;
    else if ((char === "]" || char === "}") && --depth === 0) return i + 1;
  }
  return -1;
}

// The single parser for annotation exports: the JSON array opened at `start` and
// the index just past it, or undefined when that array is not valid JSON.
function parseAnnotationArray(source: string, start: number) {
  const end = arrayEnd(source, start);
  if (end < 0) return undefined;
  const rows = json(source.slice(start, end));
  return Array.isArray(rows) ? { rows: rows as unknown[], end } : undefined;
}

// `firstIndex` is where numbering starts: each <pasted_content> block is its own
// export numbered from 1, matching its :codex-annotation{index="N"} links.
function pushAnnotations(parts: PromptParts, rows: unknown[], firstIndex: number) {
  rows.forEach((row, i) => {
    const entry = isRecord(row) ? row : {};
    parts.annotations.push({
      index: firstIndex + i,
      quote: str(entry.text),
      comment: str(entry.annotation),
    });
  });
}

// Each extractor removes one kind of attachment from the body and records it in parts.
type Extractor = (body: string, parts: PromptParts) => string;

const questionReplies: Extractor = (body, parts) =>
  body.replace(
    /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/g,
    (whole, source: string) => {
      const value = json(source);
      if (!Array.isArray(value)) return whole;
      for (const row of value) {
        if (!isRecord(row)) continue;
        if (str(row.question) || str(row.answer))
          parts.replies.push({
            header: str(row.header) || undefined,
            question: str(row.question),
            answer: str(row.answer),
          });
      }
      return "";
    },
  );

// The array must run to the end of the block and every row must carry `text`.
const pastedAnnotations: Extractor = (body, parts) =>
  body.replace(
    /<pasted_content\b[^>]*>\s*([\s\S]*?)\s*<\/pasted_content\b[^>]*>/g,
    (whole, source: string) => {
      const start = source.indexOf(PASTED_ARRAY);
      const parsed = start >= 0 ? parseAnnotationArray(source, start) : undefined;
      if (
        !parsed ||
        !JSON_WHITESPACE.test(source.slice(parsed.end)) ||
        !parsed.rows.length ||
        !parsed.rows.every((row) => isRecord(row) && "text" in row)
      )
        return whole;
      pushAnnotations(parts, parsed.rows, 1);
      return "";
    },
  );

// Bare annotation export: fixed preamble followed by a JSON array of {text, annotation, source}.
const bareAnnotationExport: Extractor = (body, parts) => {
  const preamble = body.indexOf(BARE_EXPORT_PREAMBLE);
  const start = preamble >= 0 ? body.indexOf(BARE_EXPORT_ARRAY, preamble) : -1;
  const parsed = start >= 0 ? parseAnnotationArray(body, start) : undefined;
  if (!parsed || !body.endsWith(BARE_EXPORT_ARRAY_END, parsed.end)) return body;
  pushAnnotations(parts, parsed.rows, parts.annotations.length + 1);
  return body.slice(0, preamble) + body.slice(parsed.end);
};

const fileMentionHeading: Extractor = (body) =>
  body.replace(/(?:#+\s*)?Files mentioned by the user:[ \t]*\n?/gi, "");

// "name.ext: /abs/path.ext" lines; paths may contain spaces, so match up to the same extension.
const filePathLines: Extractor = (body, parts) =>
  body.replace(
    /(?:^|(?<=\n))[ \t]*(?:#+\s*)?([^\n:]+?\.([A-Za-z0-9]{1,8})):[ \t]*(?:\/|~\/|[A-Za-z]:\\)[^\n]*?\.\2(?=\s|$)[ \t]*:?[ \t]*/g,
    (_whole, name: string) => {
      parts.files.push({ ext: extOf(name) });
      return "";
    },
  );

const imageSources: Extractor = (body, parts) =>
  body.replace(/\[Image: source: ([^\]]+)\]/g, (_whole, path: string) => {
    parts.files.push({ ext: extOf(basename(path)) });
    return "";
  });

// Inline directives become tag links (rendered as tags by the timeline).
const annotationLinks: Extractor = (body) =>
  body.replace(
    /:codex-annotation\{index="(\d+)"\}/g,
    (_whole, n: string) => `[Annotation ${n}](#annotation-${n})`,
  );

// Order matters: pasted blocks number their annotations before the bare export
// continues the count, and links are rewritten only once the JSON is gone.
const extractors: Extractor[] = [
  questionReplies,
  pastedAnnotations,
  bareAnnotationExport,
  fileMentionHeading,
  filePathLines,
  imageSources,
  annotationLinks,
];

export function parsePrompt(input: string): PromptParts {
  const parts: PromptParts = { body: "", annotations: [], replies: [], files: [] };
  const body = extractors.reduce((text, extract) => extract(text, parts), input);
  return { ...parts, body: body.replace(/\n{3,}/g, "\n\n").trim() };
}
