import type { RunnerMode } from "../shared/schema.js";
import type { Agent } from "../shared/types.js";

export function cliLoginCommand(agent: Agent, mode: RunnerMode) {
  // Codex always uses the private arena profile, including native sessions.
  // Claude's saved token serves both Docker and native runs.
  if (agent === "codex" || agent === "claude" || mode === "docker")
    return { program: "npm", args: ["run", `sandbox:login:${agent}`] };
  return { program: "cursor-agent", args: ["login"] };
}

export function missingLoginError(agent: Agent, mode: RunnerMode) {
  if (agent === "codex")
    return new Error(
      "Codex arena login is missing; run npm run sandbox:login:codex with your ChatGPT subscription",
    );
  if (agent === "claude")
    return new Error(
      "Claude Code arena login is missing; run npm run sandbox:login:claude and paste the token from claude setup-token",
    );
  return new Error(
    mode === "native"
      ? "Cursor must use saved subscription login on this Mac. Run cursor-agent login once; each native home reuses that login."
      : "Cursor must use saved subscription login; run sandbox:login:cursor",
  );
}

export function failedLoginAgent(error: unknown): Agent | undefined {
  const err = error as NodeJS.ErrnoException;
  const message = err instanceof Error ? err.message : String(error);
  const path = err.path ?? "";
  if (
    /\/runtime\/auth\/cursor(\/|$)/.test(path) ||
    /Cursor must use saved subscription login/.test(message)
  )
    return "cursor";
  if (
    /\/runtime\/auth\/codex(\/|$)/.test(path) ||
    /Codex arena login is missing/.test(message)
  )
    return "codex";
  if (
    /\/runtime\/auth\/claude(\/|$)/.test(path) ||
    /Claude Code arena login is missing|Claude subscription authentication failed/.test(message)
  )
    return "claude";
}

export function cliStartupAdvice(error: unknown, mode: RunnerMode) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (/native process group|native process record|kill EPERM/i.test(message))
    return {
      instruction:
        "Inspect the named native process group in the terminal that started it. Keep its record until the entire group is confirmed stopped. This is cleanup, not a login failure; do not use sudo or delete records blindly.",
      canRepair: false,
    };
  if (code === "EPERM" || code === "EACCES")
    return {
      instruction:
        "Resolve the permission error shown above in your normal terminal. Logging in again does not repair a permission failure.",
      canRepair: false,
    };
  const agent = failedLoginAgent(error);
  const missingAuth =
    code === "ENOENT" &&
    /\/runtime\/auth\/(codex|cursor|claude)(\/|$)/.test(
      (error as NodeJS.ErrnoException).path ?? "",
    );
  const canRepair =
    missingAuth ||
    /login is missing|must use saved .*authentication|must use saved subscription login|subscription authentication failed|not logged in|not authenticated|login required|authentication (?:failed|expired)|unauthorized|invalid.token|expired.token/i.test(
      message,
    );
  const cursorLogin =
    mode === "native"
      ? "cursor-agent login on your Mac"
      : "npm run sandbox:login:cursor";
  const advice: Record<Agent, string> = {
    codex: "Codex: npm run sandbox:login:codex (arena profile).",
    cursor: `Cursor: ${cursorLogin}.`,
    claude:
      "Claude Code: run claude setup-token, then npm run sandbox:login:claude and paste the token.",
  };
  const same = "Use the same requested models; no substitute is selected.";
  return {
    instruction: canRepair
      ? agent
        ? `${advice[agent]} ${same}`
        : `${Object.values(advice).join(" ")} ${same}`
      : "Resolve the exact CLI/model/configuration error shown above, then rerun. No login repair or model substitution is automatic.",
    canRepair,
    agent,
  };
}
