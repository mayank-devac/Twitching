// Owns the /api/boot identity contract shared by the control server and its launchers.
import { z } from "zod";

export const bootIdentitySchema = z.object({
  rootId: z.string(),
  configurationId: z.string(),
  startedAt: z.number(),
});
export type BootIdentity = z.infer<typeof bootIdentitySchema>;

// The server answers {} until its identity is known, so clients read every field as optional.
export const bootResponseSchema = bootIdentitySchema.partial();
export type BootResponse = z.infer<typeof bootResponseSchema>;

// IPv6 literals such as ::1 must be bracketed inside URLs and Host headers.
export const urlHost = (host: string) =>
  host.includes(":") ? `[${host}]` : host;
export const controlOrigin = (host: string, port: number) =>
  `http://${urlHost(host)}:${port}`;
