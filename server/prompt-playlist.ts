import { readFileSync } from "node:fs";

export const DEFAULT_PROMPT_FILE = "prompts.txt";

export function parsePromptList(text: string) {
  const prompts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.length < 10) continue;
    prompts.push(line);
  }
  return prompts;
}

export function loadPromptList(path: string) {
  try {
    return parsePromptList(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function promptPlaylistEnabled(
  prompts: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.ARENA_NO_PROMPTS === "1") return false;
  if (env.ARENA_PROMPTS === "1") return true;
  return prompts.length > 0;
}
