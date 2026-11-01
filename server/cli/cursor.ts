import { ActivityAdapter } from "../activity.js";
import { missingLoginError } from "../cli-startup-repair.js";
import type { CliAdapter, CliModel } from "./types.js";
// Cursor prints one model ID at the beginning of each listing row.
function cursorModels(output: string): CliModel[] {
  const models = output
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .flatMap((line) => {
      const match = line
        .trim()
        .match(
          /^(?:[-*•]\s+)?([a-z0-9][a-z0-9._/-]*)\s*(?:$|\s+-\s+|\s+\(|\s*[:|]\s*)/,
        );
      return match ? [{ id: match[1]!, efforts: [] }] : [];
    });
  return [...new Map(models.map((model) => [model.id, model])).values()];
}
export const cursor: CliAdapter = {
  cli: "cursor",
  edited: (event) =>
    event.type === "tool_call" && event.subtype === "completed",
  async check(host) {
    const help = await host.capture("cursor", ["cursor-agent", "--help"]);
    for (const flag of [
      "--print",
      "--stream-partial-output",
      "--output-format",
      "--model",
      "--force",
    ])
      if (!help.includes(flag))
        throw new Error(`Installed Cursor CLI lacks required ${flag}`);
  },
  async discover(host) {
    const status = await host.capture("cursor", ["cursor-agent", "status"]);
    if (
      !/logged in|authenticated/i.test(status) ||
      /not logged|not authenticated|api.?key|unauthenticated/i.test(status)
    )
      throw missingLoginError("cursor", host.executionBoundary);
    const models = cursorModels(
      await host.capture("cursor", ["cursor-agent", "--list-models"]),
    );
    if (!models.length)
      throw new Error(
        "Cursor returned no readable model IDs; check cursor-agent --list-models",
      );
    return { models };
  },
  command: (session, prompt) => [
    "cursor-agent",
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--model",
    session.model,
    "--force",
    prompt,
  ],
  activity: (session, round, clean, emit, general) =>
    new ActivityAdapter("cursor", round, clean, emit, Date.now, session.id, general),
};
