import { CLIS, CLI_LABELS, isCli, type Agent, type SessionConfig } from "../shared/types.js";
import type { CliModel } from "../server/cli/types.js";
export type Question = (text: string, fallback?: string) => Promise<string>;
export function parseSessionSpec(spec: string, index: number): SessionConfig {
  const parts = spec.split(":").map((part) => part.trim());
  const [cli, model, effort] = parts;
  if (
    index < 0 || index > 1 || !isCli(cli) ||
    !model || parts.length > 3 || effort === ""
  )
    throw new Error("Use --session cli:model[:effort], at most twice");
  return { id: `session-${index + 1}`, cli, model, ...(effort ? { effort } : {}) };
}
// Resolves shorthand model names (`--codex-6-luna`) against the CLI's own model list:
// exact id first, then a unique id ending with the name, then a unique id containing it.
export async function resolveSessionModels(
  sessions: SessionConfig[],
  discover: (cli: Agent) => Promise<CliModel[]>,
): Promise<SessionConfig[]> {
  const catalogs = new Map<Agent, CliModel[]>();
  const resolved: SessionConfig[] = [];
  for (const session of sessions) {
    if (!catalogs.has(session.cli)) catalogs.set(session.cli, await discover(session.cli));
    const models = catalogs.get(session.cli)!;
    const name = session.model.toLowerCase();
    const tiers = [
      models.filter((m) => m.id.toLowerCase() === name),
      models.filter((m) => m.id.toLowerCase().endsWith(`-${name}`) || m.id.toLowerCase().endsWith(name)),
      models.filter((m) => m.id.toLowerCase().includes(name)),
    ];
    const hits = tiers.find((tier) => tier.length > 0) ?? [];
    if (hits.length !== 1)
      throw new Error(
        `${hits.length ? "More than one" : "No"} ${session.cli} model matches "${session.model}". Available: ${models.map((m) => m.id).join(", ") || "none found"}`,
      );
    const model = hits[0]!;
    if (session.effort && model.efforts.length && !model.efforts.includes(session.effort))
      throw new Error(`${model.id} supports reasoning: ${model.efforts.join(", ")}`);
    resolved.push({ ...session, model: model.id });
  }
  return resolved;
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
    const menu = CLIS.map((cli, i) => `${i + 1} = ${CLI_LABELS[cli]}`).join(", ");
    const choice = await question(`Session ${index + 1} CLI: ${menu} [1]: `);
    const picked = choice ? Number(choice) - 1 : 0;
    const cli: Agent | undefined = Number.isInteger(picked) ? CLIS[picked] : undefined;
    if (!cli)
      throw new Error(`Choose ${CLIS.map((c) => CLI_LABELS[c]).join(", ")}`);
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
