import type { Agent, SessionConfig } from "../shared/types.js";
import type { CliModel } from "../server/cli/types.js";
export type Question = (text: string, fallback?: string) => Promise<string>;
export function parseSessionSpec(spec: string, index: number): SessionConfig {
  const parts = spec.split(":").map((part) => part.trim());
  const [cli, model, effort] = parts;
  if (
    index < 0 || index > 1 || !["codex", "cursor"].includes(cli) ||
    !model || parts.length > 3 || effort === ""
  )
    throw new Error("Use --session cli:model[:effort], at most twice");
  return { id: `session-${index + 1}`, cli: cli as Agent, model, ...(effort ? { effort } : {}) };
}
export async function chooseSessions(
  question: Question,
  discover: (cli: Agent) => Promise<CliModel[]>,
  log: (text: string) => void,
): Promise<SessionConfig[] | undefined> {
  const count = await question("Sessions: Enter = keep configured choices, 1 = choose one, 2 = choose two: ");
  if (!count) return undefined;
  if (count !== "1" && count !== "2") throw new Error("Choose 1 or 2 sessions");
  const catalogs = new Map<Agent, CliModel[]>();
  const sessions: SessionConfig[] = [];
  for (let index = 0; index < Number(count); index++) {
    const choice = await question(`Session ${index + 1} CLI: 1 = Codex, 2 = Cursor [1]: `);
    if (!["", "1", "2"].includes(choice))
      throw new Error("Choose Codex or Cursor");
    const cli: Agent = choice === "2" ? "cursor" : "codex";
    if (!catalogs.has(cli)) catalogs.set(cli, await discover(cli));
    const models = catalogs.get(cli)!;
    models.forEach((model, i) => log(`  ${i + 1}. ${model.id}`));
    const selected = Number(await question(`Session ${index + 1} model number: `)) - 1;
    if (!Number.isInteger(selected) || !models[selected])
      throw new Error("Choose a listed model number");
    const model = models[selected];
    let effort: string | undefined;
    if (model.efforts.length) {
      log(`  Supported reasoning: ${model.efforts.join(", ")}`);
      effort = (await question("Reasoning effort (Enter = CLI default): ")).trim() || undefined;
      if (effort && !model.efforts.includes(effort))
        throw new Error("Choose a listed reasoning effort");
    }
    sessions.push({ id: `session-${index + 1}`, cli, model: model.id, ...(effort ? { effort } : {}) });
  }
  return sessions;
}
