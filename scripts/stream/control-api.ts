// Owns the launcher's validated reads of /api/state and its CSRF-guarded /api/action calls.
import { z } from "zod";

// Only the fields the launcher reads; the controller's full state stays server-side.
export const rehearsalSchema = z.object({
  rehearsalComplete: z.boolean().optional(),
  rehearsalRunnerMode: z.string().optional(),
});
export const launcherStateSchema = rehearsalSchema.extend({
  status: z.string(),
  reason: z.string().optional(),
  round: z
    .object({
      attempts: z.record(z.string(), z.object({ status: z.string() })),
    })
    .partial()
    .nullish(),
});
export type LauncherState = z.infer<typeof launcherStateSchema>;
const hostSchema = z.object({ csrf: z.string() });
const actionResultSchema = z.object({ error: z.unknown().optional() });

// Network and JSON errors propagate; an unexpected shape reads as undefined so
// callers treat it as "not ready / not confirmed" rather than crashing on a field.
export const parseLauncherState = (value: unknown) => {
  const parsed = launcherStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
export async function fetchState(origin: string, timeoutMs?: number) {
  const response = await fetch(`${origin}/api/state`, {
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  return parseLauncherState(await response.json());
}

export const showIsBusy = (state: LauncherState | undefined) =>
  !["paused", "stopped"].includes(state?.status ?? "") ||
  Object.values(state?.round?.attempts ?? {}).some((attempt) =>
    ["running", "validating"].includes(attempt.status),
  );

// Same host session the control panel uses: fetch a CSRF token + cookie, then act.
export async function hostAction(
  origin: string,
  clean: (text: string) => string,
  actionName: string,
  text?: string,
) {
  const hostResponse = await fetch(`${origin}/api/host`, {
    signal: AbortSignal.timeout(2000),
  });
  const host = hostSchema.safeParse(await hostResponse.json());
  if (!host.success) throw new Error("Host action failed");
  const cookie = hostResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
  const response = await fetch(`${origin}/api/action`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Host-Token": host.data.csrf,
      Cookie: cookie,
    },
    body: JSON.stringify({ action: actionName, ...(text ? { text } : {}) }),
    signal: AbortSignal.timeout(180000),
  });
  const result = actionResultSchema.safeParse(await response.json());
  if (!response.ok)
    throw new Error(
      clean(
        String((result.success ? result.data.error : undefined) ??
          "Host action failed"),
      ),
    );
  return fetchState(origin);
}
