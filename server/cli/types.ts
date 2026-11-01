import type { CliEvent } from "./events.js";
import type { Activity, Agent, SessionConfig } from "../../shared/types.js";
import type { Docker } from "../docker.js";

interface CliActivity {
  successful: boolean;
  failure?: string;
  receive(event: CliEvent): void;
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
  edited(event: CliEvent): boolean;
  command(session: SessionConfig, prompt: string): string[];
  activity(
    session: SessionConfig,
    round: number,
    clean: Clean,
    emit: (event: Activity) => void,
    general?: boolean,
  ): CliActivity;
}
