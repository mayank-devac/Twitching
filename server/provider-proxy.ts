import { execFileSync } from "node:child_process";
import { AGENT_NETWORK } from "./constants.js";

export type ProviderProxyState = "ready" | "down" | "open";

export function providerProxyState(
  internal: string | undefined,
  egressRunning: boolean,
): ProviderProxyState {
  if (internal !== "true") return internal === undefined ? "down" : "open";
  return egressRunning ? "ready" : "down";
}

export function providerProxyInstruction(state: ProviderProxyState) {
  if (state === "ready") return "";
  if (state === "open")
    return `${AGENT_NETWORK} is not an internal network. Never replace the internal network with an unrestricted network.`;
  return "The HTTPS provider proxy is not running. Run docker compose -f sandbox/compose.yml up -d. Codex login and Docker agents use this proxy. Never replace the internal network with an unrestricted network.";
}

export function assertProviderProxy(cwd: string) {
  const run = (args: string[]) =>
    execFileSync("docker", args, {
      cwd,
      encoding: "utf8",
      timeout: 15000,
    }).trim();
  let internal: string | undefined;
  try {
    internal = run([
      "network",
      "inspect",
      AGENT_NETWORK,
      "--format",
      "{{.Internal}}",
    ]);
  } catch {
    internal = undefined;
  }
  let egressRunning = false;
  if (internal === "true") {
    try {
      const id = run(["compose", "-f", "sandbox/compose.yml", "ps", "-q", "egress"]);
      egressRunning =
        id.length > 0 &&
        run(["inspect", "--format", "{{.State.Running}}", id.split("\n")[0]]) ===
          "true";
    } catch {
      egressRunning = false;
    }
  }
  const problem = providerProxyInstruction(
    providerProxyState(internal, egressRunning),
  );
  if (problem) throw new Error(problem);
}
