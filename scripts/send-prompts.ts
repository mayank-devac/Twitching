// `./start_stream.sh send [--check] ["prompt" ...]`: talks to the running app on this
// machine, the same way the Send prompts button does. It never starts the app.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { controlOrigin } from "../shared/boot.js";

const usage = `Send prompts to the running Prompt Arena

  ./start_stream.sh send                    run every task in prompts.txt (re-read now)
  ./start_stream.sh send "prompt one" "two"  run only these prompts
  ./start_stream.sh send --check            show what prompts.txt holds, send nothing

Start the app first (./start_stream.sh ...). Each prompt runs on every configured session.`;

const hostSchema = z.object({ csrf: z.string() });
const replySchema = z.object({
  error: z.unknown().optional(),
  count: z.number().optional(),
  file: z.string().optional(),
  prompts: z.array(z.string()).optional(),
});

export async function sendPrompts(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  const check = args.includes("--check");
  const texts = args.filter((arg) => !arg.startsWith("--"));
  if (args.some((arg) => arg.startsWith("--") && arg !== "--check")) {
    console.error(`ERROR: Unknown option.\n${usage}`);
    process.exitCode = 2;
    return;
  }
  const settings = JSON.parse(readFileSync(resolve(process.cwd(), "settings.json"), "utf8")) as {
    host?: string;
    port?: number;
  };
  const origin = controlOrigin(settings.host ?? "127.0.0.1", settings.port ?? 3210);
  try {
    const hostResponse = await fetch(`${origin}/api/host`, { signal: AbortSignal.timeout(2000) });
    const host = hostSchema.parse(await hostResponse.json());
    const cookie = hostResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
    const headers = { Origin: origin, "X-Host-Token": host.csrf, Cookie: cookie };
    const response = check
      ? await fetch(`${origin}/api/prompts`, { headers, signal: AbortSignal.timeout(5000) })
      : await fetch(`${origin}/api/prompts`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(texts.length ? { prompts: texts } : {}),
          signal: AbortSignal.timeout(10000),
        });
    const reply = replySchema.parse(await response.json());
    if (!response.ok) throw new Error(String(reply.error ?? "Request failed"));
    if (check) {
      console.log(`${reply.file}: ${reply.prompts?.length ?? 0} tasks`);
      reply.prompts?.forEach((prompt, i) => console.log(`  ${i + 1}. ${prompt}`));
    } else console.log(`Sent ${reply.count} prompts${texts.length ? "" : ` from ${reply.file}`}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    console.error(
      /fetch failed|ECONNREFUSED|timeout/i.test(message)
        ? `ERROR: The app is not running at ${origin}. Start it first with ./start_stream.sh.`
        : `ERROR: ${message}`,
    );
    process.exitCode = 1;
  }
}
