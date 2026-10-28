import type { Activity, Agent, SessionConfig } from "../../shared/types.js";
import type { Docker } from "../docker.js";
export class LoginRefreshConflict extends Error {}

export interface CliActivity {
  successful: boolean;
  failure?: string;
  receive(event: any): void;
}
export interface CliCatalog {
  models: CliModel[];
  limits?: unknown;
}
export interface CliModel {
  id: string;
  efforts: string[];
}
export type Clean = (
  text: string,
  limit?: number,
  streaming?: boolean,
) => string;
export interface CliAdapter {
  cli: Agent;
  check(host: Docker): Promise<void>;
  discover(host: Docker): Promise<CliCatalog>;
  edited(event: any): boolean;
  command(session: SessionConfig, prompt: string): string[];
  activity(
    session: SessionConfig,
    round: number,
    clean: Clean,
    emit: (event: Activity) => void,
  ): CliActivity;
}
