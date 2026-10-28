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
  }).nullable().optional(),
  message: z.union([
    z.string(),
    z.object({
      content: z.array(z.object({
        type: z.string(),
        text: z.string().optional(),
      })).optional(),
    }),
  ]).nullable().optional(),
  error: z.object({ message: z.string().optional() }).nullable().optional(),
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
