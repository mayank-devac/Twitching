import { ActivityAdapter } from "../activity.js";
import { CODEX_EXEC_PROFILE_ARGS } from "../codex-profile.js";
import { missingLoginError } from "../cli-startup-repair.js";
import type { CliAdapter } from "./types.js";
export const codex: CliAdapter = {
  cli: "codex",
  async check(host) {
    const help = await host.capture("codex", ["codex", "exec", "--help"]);
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--disable"])
      if (!help.includes(flag))
        throw new Error(
          `Installed Codex CLI lacks required isolation control ${flag}`,
        );
  },
  async discover(host) {
    const info = await host.codexInfo();
    if (info.account !== "chatgpt")
      throw missingLoginError("codex", host.executionBoundary);
    return {
      limits: info.limits,
      models: info.models.map((model) => ({
        id: model.model,
        efforts: (model.supportedReasoningEfforts ?? []).map(
          (e) => e.reasoningEffort,
        ),
      })),
    };
  },
  command(session, prompt) {
    return [
      "codex",
      "exec",
      ...CODEX_EXEC_PROFILE_ARGS,
      "--json",
      "--skip-git-repo-check",
      "--model",
      session.model,
      ...(session.effort
        ? ["-c", `model_reasoning_effort=${JSON.stringify(session.effort)}`]
        : []),
      "--dangerously-bypass-approvals-and-sandbox",
      prompt,
    ];
  },
  activity: (session, round, clean, emit, run, root) =>
    new ActivityAdapter("codex", round, clean, emit, Date.now, session.id, run.general, root, {
      edited: (event) =>
        event.type === "item.completed" &&
        ["file_change", "command_execution"].includes(event.item?.type ?? ""),
    }),
};
