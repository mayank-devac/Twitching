import express from "express";
import { z } from "zod";
import type { Controller } from "./controller.js";
import { HttpError, routeAction, type HostOnly } from "./http-kit.js";
import { loadPromptList } from "./prompt-playlist.js";

const sendBody = z
  .object({ prompts: z.array(z.string().max(700)).min(1).max(50).optional() })
  .strict();

// Host-only routes: GET re-reads the prompt file so the desk can show what changed;
// POST runs either the file's tasks or the prompts typed on the CLI.
export function promptRoutes(
  app: express.Express,
  controller: Controller,
  promptPath: string,
  promptFile: string,
  guard: HostOnly,
) {
  // The last list sent, so the desk can tell the host the file has new edits.
  let sent: string[] = [];
  const read = () => {
    const prompts = loadPromptList(promptPath);
    return {
      file: promptFile,
      prompts,
      changed: JSON.stringify(prompts) !== JSON.stringify(sent),
      sentCount: sent.length,
    };
  };
  app.get(
    "/api/prompts",
    guard("Use the local control panel to read the prompt file"),
    routeAction(() => read(), { status: 500, failed: "Prompt file could not be read" }),
  );
  app.post(
    "/api/prompts",
    guard("Use the local control panel to send prompts"),
    express.json({ limit: "64kb" }),
    routeAction(
      (req) => {
        const input = sendBody.safeParse(req.body ?? {});
        if (!input.success) throw new HttpError(400, "Invalid prompt list");
        const prompts = input.data.prompts ?? loadPromptList(promptPath);
        if (!prompts.length)
          throw new HttpError(400, `No tasks in ${promptFile}. Add one prompt per line.`);
        const count = controller.sendPrompts(prompts);
        if (!input.data.prompts) sent = prompts;
        return { ok: true, count, ...read() };
      },
      { status: 409, failed: "Prompts were not sent" },
    ),
  );
}
