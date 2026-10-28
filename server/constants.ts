// Infrastructure identifiers and limits shared by the Docker runner, preview
// sandbox and login scripts. Changing a value here must be mirrored in
// sandbox/compose.yml and any existing networks on the host.
export const AGENT_NETWORK = "stram_agents";
export const PREVIEW_NETWORK = "stram_previews";
export const EGRESS_PROXY = "http://egress:3128";
export const PREVIEW_CDP_PORT = 9222;
export const RUNNER_LIMITS = {
  pids: 128,
  memory: "2g",
  cpus: "2",
  user: "1000:1000",
} as const;
export const PREVIEW_BROWSER_LIMITS = {
  pids: 256,
  memory: "2g",
  cpus: "2",
  user: "1000:1000",
  shm: "256m",
} as const;
