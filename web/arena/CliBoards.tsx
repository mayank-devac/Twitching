// The host's per-agent CLI activity boards: one scrolling column per activity lane.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { sessionCli } from "../../shared/types.js";
import type { Activity, ActivityLane, SessionId, ShowState } from "../../shared/types.js";
import codexLogo from "../../assets/codex/codex.svg";
import cursorLogo from "../../assets/cursor/Cube/SVG/CUBE_2D_DARK.svg";

const lanes: ActivityLane[] = ["read", "write", "tool", "terminal"];
const laneLabel: Record<ActivityLane, string> = {
  read: "READ",
  write: "WRITE",
  tool: "tool call",
  terminal: "terminal use",
};
const CLI_TAG_MS = 1400;
const noRows: Activity[] = [];
function CliColumn({
  agent,
  cli,
  lane,
  rows,
}: {
  agent: SessionId;
  cli: string | undefined;
  lane: ActivityLane;
  rows: Activity[];
}) {
  const log = useRef<HTMLUListElement>(null);
  const textSize = useMemo(
    () => rows.reduce((size, row) => size + row.text.length, 0),
    [rows],
  );
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [rows.length, textSize]);
  const [tagVisible, setTagVisible] = useState(false);
  const hideTagTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(hideTagTimer.current), []);
  const flashTag = () => {
    clearTimeout(hideTagTimer.current);
    setTagVisible(true);
    hideTagTimer.current = setTimeout(() => setTagVisible(false), CLI_TAG_MS);
  };
  const hideTag = () => {
    clearTimeout(hideTagTimer.current);
    setTagVisible(false);
  };
  return (
    <div
      className="cli-column"
      aria-label={`${agent} ${laneLabel[lane]}`}
      onMouseEnter={flashTag}
      onMouseLeave={hideTag}
      onFocus={flashTag}
      onBlur={hideTag}
    >
      <span
        className={`cli-column-tag${tagVisible ? " visible" : ""}`}
        aria-hidden="true"
      >
        <img src={cli === "cursor" ? cursorLogo : codexLogo} alt="" />
        {laneLabel[lane]}
      </span>
      <ul ref={log}>
        {rows.map((row) => (
          <li
            key={row.id}
            className={lane === "terminal" ? "command-line" : undefined}
          >
            {row.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
export function CliBoards({ state }: { state: ShowState }) {
  const agents = state.agents ?? (["cursor", "codex"] as const);
  // One pass per events change instead of agents×lanes filters on every render.
  const rowsByLane = useMemo(() => {
    const groups = new Map<string, Activity[]>();
    for (const event of state.events) {
      if (!event.lane) continue;
      const key = `${event.agent}:${event.lane}`;
      const rows = groups.get(key);
      if (rows) rows.push(event);
      else groups.set(key, [event]);
    }
    return groups;
  }, [state.events]);
  return (
    <div className={`cli-boards ${state.agents?.length === 1 ? "solo" : ""}`}>
      {agents.map((agent) => (
        <section
          key={agent}
          className="cli-board"
          aria-label={`${agent} activity`}
        >
          <div className="cli-columns">
            {lanes.map((lane) => {
              const rows = rowsByLane.get(`${agent}:${lane}`) ?? noRows;
              return (
                <CliColumn
                  key={lane}
                  agent={agent}
                  cli={sessionCli(state, agent)}
                  lane={lane}
                  rows={rows}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
