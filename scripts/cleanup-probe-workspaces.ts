import { cleanupProbeWorkspaces } from "../server/probe-workspace-cleanup.js";
import { root } from "../server/config.js";

const dryRun = process.argv.includes("--dry-run");
const { removed, skipped } = await cleanupProbeWorkspaces(root, { dryRun });

if (removed.length) {
  console.log(dryRun ? "Would remove:" : "Removed:");
  for (const path of removed) console.log(`  ${path}`);
}
if (skipped.length) {
  console.log("Skipped non-empty probe workspaces:");
  for (const path of skipped) console.log(`  ${path}`);
}
if (!removed.length && !skipped.length)
  console.log("No probe workspaces found.");
