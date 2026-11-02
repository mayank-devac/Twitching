// On Ctrl+C: if the arena setup in use was never saved, offer to keep it as the default.
import { createInterface } from "node:readline/promises";
import { hostSettings } from "./control-api.js";
import { launcher } from "./runtime.js";

export function offerSaveDefaultOnExit(origin: string, interactive: boolean) {
  if (!interactive) return;
  launcher.beforeExit = async () => {
    try {
      if (!(await hostSettings(origin, false)).unsaved) return;
      // The launcher's own prompt is closed so the answer is read by one interface only.
      launcher.input?.close();
      const ask = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await ask
        .question("\nSave this arena setup (CLIs, models, effort) as the default? [y/N]: ")
        .catch(() => "")
        .finally(() => ask.close());
      if (/^(y|yes)$/i.test(answer.trim())) {
        await hostSettings(origin, true);
        console.log("Saved. It will be the default arena next time.");
      }
    } catch {
      /* The app may already be gone; shutdown continues. */
    }
  };
}
