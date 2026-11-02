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

// The file never starts a playlist by itself: only --prompts (ARENA_PROMPTS=1) does.
// Otherwise the host sends the file's tasks with the Send button or `send` command.
export function promptPlaylistEnabled(
  _prompts: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.ARENA_NO_PROMPTS === "1") return false;
  return env.ARENA_PROMPTS === "1";
}

// Tasks from the CLI or the file must pass the same length rule as host prompts.
export function validatePromptTexts(texts: string[], max: number) {
  const prompts = texts.map((text) => text.trim()).filter(Boolean);
  if (!prompts.length) throw new Error("No prompts to send");
  for (const prompt of prompts)
    if (prompt.length < 10 || prompt.length > max || /[\u0000-\u0008]/.test(prompt))
      throw new Error(
        `Each prompt needs 10–${max} characters: "${prompt.slice(0, 40)}"`,
      );
  return prompts;
}
