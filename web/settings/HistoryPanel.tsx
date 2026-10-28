import React, { useEffect, useState } from "react";
import type { HistoryPage } from "../../shared/settings.js";
import type { Round } from "../../shared/types.js";
import { hostRequest } from "./api.js";

// History is read-only and paginated; opening this panel never reruns a prompt.
export function HistoryPanel({ token }: { token: string }) {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [before, setBefore] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(cursor?: number) {
    setBusy(true);
    setError("");
    try {
      const page = await hostRequest<HistoryPage>(
        token,
        `/api/history${cursor ? `?before=${cursor}` : ""}`,
      );
      setRounds((old) => (cursor ? [...old, ...page.rounds] : page.rounds));
      setBefore(page.before);
    } catch (e) {
      setError(e instanceof Error ? e.message : "History unavailable");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (token) void load();
  }, [token]);
  return (
    <details className="qs-card qs-history">
      <summary>
        Prompt history <small>Past rounds</small>
      </summary>
      <div className="qs-row">
        <h3>Past prompts</h3>
        <button disabled={busy} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {!rounds.length && (
        <p className="qs-hint">{busy ? "Loading…" : "No saved rounds yet."}</p>
      )}
      <ol>
        {rounds.map((r) => (
          <li key={r.id}>
            <small>
              Round {r.id} · {new Date(r.launchedAt).toLocaleString()}
            </small>
            <p>{r.task.text}</p>
            <small>
              {Object.entries(r.attempts)
                .map(([id, a]) => `${id}: ${a.model} · ${a.status}`)
                .join(" / ")}
            </small>
          </li>
        ))}
      </ol>
      {before && (
        <button disabled={busy} onClick={() => void load(before)}>
          Load 20 older rounds
        </button>
      )}
      {error && (
        <p className="qs-error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
