// Owns the zod building blocks that several request, settings and startup schemas share.
// Server-only at runtime: web code imports these names as types, never values, so zod stays out of the bundle.
import { z } from "zod";
import { CLIS, SESSION_IDS, validSessionId } from "./types.js";

export const cliSchema = z.enum(CLIS);

// Where agent CLIs execute: the Docker sandbox or, with explicit consent, the host.
export const RUNNER_MODES = ["docker", "native"] as const;
export const runnerModeSchema = z.enum(RUNNER_MODES);
export type RunnerMode = z.infer<typeof runnerModeSchema>;

export const streamModeSchema = z.enum(["live", "rehearsal"]);

export const sessionIdSchema = z
  .string()
  .refine(validSessionId, `Use ${SESSION_IDS.join(", ")}`);

// Saved and requested sessions are bounded; startup settings reuse the id/cli rules with looser text limits.
export const sessionConfigSchema = z
  .object({
    id: sessionIdSchema,
    cli: cliSchema,
    model: z.string().trim().min(1).max(160),
    effort: z.string().trim().min(1).max(40).optional(),
    // Absent: the runner the app was launched with. Native needs host consent when saved.
    runner: runnerModeSchema.optional(),
  })
  .strict();
export type SessionConfig = z.infer<typeof sessionConfigSchema>;

// One or two sessions, each id used once.
export function sessionListSchema<T extends z.ZodType<{ id: string }>>(
  session: T,
) {
  return z
    .array(session)
    .min(1)
    .max(2)
    .refine(
      (sessions) => new Set(sessions.map((s) => s.id)).size === sessions.length,
      "Session IDs must be unique",
    );
}
