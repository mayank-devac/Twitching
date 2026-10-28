import { createInterface } from "node:readline/promises";
import {
  availableSandboxResults,
  parseSandboxResultSelection,
  preserveSelectedSandboxResults,
  preserveUnexportedSandboxResults,
  sandboxResultPath,
} from "../server/sandbox-results.js";

async function main() {
  const root = process.cwd();
  const results = await availableSandboxResults(root);

  if (!results.length) {
    console.log("No Docker sandbox prompts are available.");
    return;
  }

  console.log("Available Docker sandbox prompts:\n");
  for (const [index, result] of results.entries()) {
    const status = result.exported ? "exported" : "not exported";
    const location = result.archived ? "archived workspace" : "workspace";
    console.log(
      `${index + 1}. Round ${result.round} · ${result.agent} · ${status} · ${location}`,
    );
  }
  const unexported = results.filter((result) => !result.exported).length;
  console.log(`A. Export all not exported (${unexported})`);

  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let answer: string;
  try {
    answer = await prompt.question(
      "\nSelect prompt number(s), separated by commas, or A to export all: ",
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.log("\nCancelled. Nothing was exported.");
      process.exitCode = 130;
      return;
    }
    throw error;
  } finally {
    prompt.close();
  }

  const selection = parseSandboxResultSelection(answer, results.length);
  if (selection === "all") {
    if (!unexported) {
      console.log("All available sandbox prompts are already exported.");
    } else {
      const { saved, failed } = await preserveUnexportedSandboxResults(
        root,
        results,
      );
      console.log(`Exported ${saved.length} sandbox prompt(s).`);
      if (failed.length) {
        console.error(
          `Could not export ${failed.length} prompt(s) because their files disappeared or became unsafe.`,
        );
        process.exitCode = 1;
      }
    }
  } else if (!selection) {
    console.error("Invalid selection. Nothing was exported.");
    process.exitCode = 1;
  } else {
    const selected = selection.map((index) => results[index]);
    const { saved, failed } = await preserveSelectedSandboxResults(
      root,
      selected,
    );
    if (selected.length === 1 && saved.length === 1) {
      const result = saved[0];
      const destination = sandboxResultPath(root, result.agent, result.round);
      console.log(
        `${result.exported ? "Re-exported" : "Exported"} to ${destination}`,
      );
    } else console.log(`Exported ${saved.length} selected sandbox prompt(s).`);
    if (failed.length) {
      console.error(
        `Could not export ${failed.length} selected prompt(s) because their files disappeared or became unsafe.`,
      );
      process.exitCode = 1;
    }
  }
}

await main();
