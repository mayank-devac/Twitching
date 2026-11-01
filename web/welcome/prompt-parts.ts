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

export function parsePrompt(input: string): PromptParts {
  let body = input;
  const annotations: PromptAnnotation[] = [];
  const replies: PromptReply[] = [];
  const files: PromptFile[] = [];
  // `firstIndex` is where numbering starts: each <pasted_content> block is its own
  // export numbered from 1, matching its :codex-annotation{index="N"} links.
  const pushAnnotations = (rows: unknown[], firstIndex: number) => {
    rows.forEach((row, i) => {
      const entry = isRecord(row) ? row : {};
      annotations.push({
        index: firstIndex + i,
        quote: str(entry.text),
        comment: str(entry.annotation),
      });
    });
  };

  body = body.replace(
    /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/g,
    (whole, source: string) => {
      const value = json(source);
      if (!Array.isArray(value)) return whole;
      for (const row of value) {
        if (!isRecord(row)) continue;
        if (str(row.question) || str(row.answer))
          replies.push({
            header: str(row.header) || undefined,
            question: str(row.question),
            answer: str(row.answer),
          });
      }
      return "";
    },
  );

  body = body.replace(
    /<pasted_content\b[^>]*>\s*([\s\S]*?)\s*<\/pasted_content\b[^>]*>/g,
    (whole, source: string) => {
      const start = source.indexOf("[{");
      const value = start >= 0 ? json(source.slice(start)) : undefined;
      if (
        !Array.isArray(value) ||
        !value.length ||
        !value.every((row) => isRecord(row) && "text" in row)
      )
        return whole;
      pushAnnotations(value, 1);
      return "";
    },
  );

  // Bare annotation export: fixed preamble followed by a JSON array of {text, annotation, source}.
  const preamble = body.indexOf("Each item contains text selected");
  const jsonStart = preamble >= 0 ? body.indexOf('[{"text"', preamble) : -1;
  if (jsonStart >= 0) {
    for (
      let end = body.lastIndexOf("}]");
      end > jsonStart;
      end = body.lastIndexOf("}]", end - 1)
    ) {
      const value = json(body.slice(jsonStart, end + 2));
      if (!Array.isArray(value)) continue;
      pushAnnotations(value, annotations.length + 1);
      body = body.slice(0, preamble) + body.slice(end + 2);
      break;
    }
  }

  // "name.ext: /abs/path.ext" lines; paths may contain spaces, so match up to the same extension.
  body = body.replace(
    /(?:#+\s*)?Files mentioned by the user:[ \t]*\n?/gi,
    "",
  );
  body = body.replace(
    /(?:^|(?<=\n))[ \t]*(?:#+\s*)?([^\n:]+?\.([A-Za-z0-9]{1,8})):[ \t]*(?:\/|~\/|[A-Za-z]:\\)[^\n]*?\.\2(?=\s|$)[ \t]*:?[ \t]*/g,
    (_whole, name: string) => {
      files.push({ ext: extOf(name) });
      return "";
    },
  );
  body = body.replace(/\[Image: source: ([^\]]+)\]/g, (_whole, path: string) => {
    files.push({ ext: extOf(basename(path)) });
    return "";
  });

  // Inline directives become tag links (rendered as tags by the timeline).
  body = body.replace(
    /:codex-annotation\{index="(\d+)"\}/g,
    (_whole, n: string) => `[Annotation ${n}](#annotation-${n})`,
  );
  return { body: body.replace(/\n{3,}/g, "\n\n").trim(), annotations, replies, files };
}
