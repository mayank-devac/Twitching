import React from "react";
import { parsePrompt } from "./prompt-parts.js";
import { TimelineMarkdown } from "./timeline-markdown.js";

// A prompt is shown as: readable text, then annotation cards, question replies
// and file tags. Local file paths and wrapper JSON never reach the screen.
export const PromptText = React.memo(function PromptText({
  text,
}: {
  text: string;
}) {
  const { body, annotations, replies, files } = parsePrompt(text);
  return (
    <div className="prompt-parts">
      {body && <TimelineMarkdown text={body} />}

      {annotations.length > 0 && (
        <ul className="cards" aria-label="Annotations">
          {annotations.map((a) => (
            <li key={a.index} className="card">
              <span className="tag tag-annotation">Annotation {a.index}</span>
              {a.quote && <p className="card-quote">{a.quote}</p>}
              {a.comment && (
                <p className="card-note">
                  <b>Comment:</b> {a.comment}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {replies.length > 0 && (
        <ul className="cards" aria-label="Question replies">
          {replies.map((r, i) => (
            <li key={i} className="card">
              <span className="tag tag-reply">{r.header || "Question reply"}</span>
              {r.question && <p className="card-note">{r.question}</p>}
              {r.answer && <p className="card-answer">{r.answer}</p>}
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <div className="prompt-files" aria-label="Attached files">
          {files.map((f, i) => (
            <span key={i} className="tag tag-file">
              <b>{f.ext}</b> mentioned
            </span>
          ))}
        </div>
      )}
    </div>
  );
});
