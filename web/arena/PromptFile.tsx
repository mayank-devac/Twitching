// "Send prompts" desk: re-reads prompts.txt on demand, shows what is in it and
// runs those tasks only when the host presses Send. Nothing runs by itself.
import React from "react";
import { hostRequest } from "../settings/api.js";
import { useHostAction } from "../use-host-action.js";

interface PromptFileInfo {
  file: string;
  prompts: string[];
  changed: boolean;
  sentCount: number;
}

export function PromptFile({ token, canSend }: { token: string; canSend: boolean }) {
  const { busy, error, notice, setNotice, run } = useHostAction();
  const [info, setInfo] = React.useState<PromptFileInfo>();
  const [open, setOpen] = React.useState(false);

  const check = () =>
    run(async () => {
      const next = await hostRequest<PromptFileInfo>(token, "/api/prompts", undefined, "GET", {
        error: "Prompt file could not be read",
      });
      setInfo(next);
      setOpen(true);
      setNotice(
        next.prompts.length
          ? next.changed
            ? `${next.prompts.length} prompts found${next.sentCount ? " (file changed since the last send)" : ""}`
            : "No new prompts since the last send"
          : `No tasks in ${next.file}`,
      );
    }, "Prompt file could not be read");

  const send = () =>
    run(async () => {
      const result = await hostRequest<PromptFileInfo & { count: number }>(
        token,
        "/api/prompts",
        {},
        "POST",
        { error: "Prompts were not sent" },
      );
      setInfo(result);
      setOpen(true);
      setNotice(`Sent ${result.count} prompts from ${result.file}`);
    }, "Prompts were not sent");

  return (
    <div className="prompt-file">
      <div className="buttons">
        <button type="button" disabled={busy || !token} onClick={check}>
          Check prompts
        </button>
        <button
          type="button"
          disabled={busy || !token || !canSend}
          title={`Run the tasks in ${info?.file ?? "prompts.txt"} on every session`}
          onClick={send}
        >
          Send prompts
        </button>
        {info && (
          <button type="button" className="cli-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Hide list" : "Show list"}
          </button>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {open && info && (
        <ol>
          {info.prompts.map((prompt, i) => (
            <li key={`${i}-${prompt}`}>{prompt}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
