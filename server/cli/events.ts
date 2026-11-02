import { z } from "zod";
// Validate external JSON before either CLI parser reads nested properties.
const eventSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  item: z.object({
    type: z.string(),
    id: z.union([z.string(), z.number()]).optional(),
    text: z.string().optional(),
    command: z.string().optional(),
    exit_code: z.number().nullable().optional(),
    aggregated_output: z.string().optional(),
    changes: z.array(z.object({ path: z.string().optional() })).optional(),
    status: z.string().optional(),
    // Codex web_search items carry the search query.
    query: z.string().optional(),
  }).nullable().optional(),
  message: z.union([
    z.string(),
    z.object({
      content: z.array(z.object({
        type: z.string(),
        text: z.string().optional(),
        // Claude Code blocks: thinking, tool_use and tool_result.
        thinking: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        input: z.unknown().optional(),
        tool_use_id: z.string().optional(),
        content: z.unknown().optional(),
        is_error: z.boolean().optional(),
      })).optional(),
    }),
  ]).nullable().optional(),
  // Codex sends {message}; Claude's system/api_retry sends an error kind string.
  error: z.union([
    z.string(),
    z.object({ message: z.string().optional() }),
  ]).nullable().optional(),
  // Claude Code system/init and result fields.
  session_id: z.string().optional(),
  mcp_servers: z.array(z.unknown()).optional(),
  plugins: z.array(z.unknown()).optional(),
  errors: z.array(z.unknown()).optional(),
  terminal_reason: z.string().optional(),
  timestamp_ms: z.union([z.string(), z.number()]).optional(),
  model_call_id: z.string().optional(),
  text: z.string().optional(),
  tool_call: z.record(z.string(), z.unknown()).nullable().optional(),
  call_id: z.union([z.string(), z.number()]).optional(),
  is_error: z.boolean().optional(),
  result: z.unknown().optional(),
});
export type CliEvent = z.infer<typeof eventSchema>;
export function parseCliEvent(value: unknown): CliEvent | undefined {
  const parsed = eventSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
