import type { CliEvent } from "./events.js";
import type { Activity, Agent, RunnerMode, SessionConfig } from "../../shared/types.js";
import type { Docker } from "../docker.js";

// Where a run executes and what it is for. Adapters choose their safety
// profile from this directly; hosts never rewrite a built command.
export interface RunContext {
  boundary: RunnerMode;
  // A general coding session rather than an arena HTML round.
  general: boolean;
}

// One run's parser. Per-run state (pending tool calls) lives and dies with it.
interface CliActivity {
  successful: boolean;
  failure?: string;
  receive(event: CliEvent): void;
  // True when this event finished a step that may have changed files.
  edited(event: CliEvent): boolean;
}
export interface CliCatalog {
  models: CliModel[];
  limits?: unknown;
}
export interface CliModel {
  id: string;
  efforts: string[];
}
type Clean = (
  text: string,
  limit?: number,
  streaming?: boolean,
) => string;
export interface CliAdapter {
  cli: Agent;
  check(host: Docker): Promise<void>;
  discover(host: Docker): Promise<CliCatalog>;
  command(session: SessionConfig, prompt: string, run: RunContext): string[];
  activity(
    session: SessionConfig,
    round: number,
    clean: Clean,
    emit: (event: Activity) => void,
    run: RunContext,
    // Folder the agent works in; absolute paths inside it are shown relative to it.
    root?: string,
  ): CliActivity;
}
