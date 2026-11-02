import { redactor } from "./redact.js";
import type { secrets as loadedSecrets } from "./config.js";

type Secrets = typeof loadedSecrets;

// One list of values that must never reach logs, the stream or the UI. The server
// and the launcher both build their redactors from it, so they cannot drift.
// Redacting a public ID too is acceptable; redacting fewer values is not.
export function privateValues(secrets: Secrets): string[] {
  return [
    secrets.jev,
    ...Object.values(secrets.youtube),
    ...Object.values(secrets.twitch),
    ...Object.values(secrets.kick),
    secrets.obs,
  ];
}

// Builds a redactor over privateValues plus any Kick app token minted at runtime.
// `currentKickToken` is polled on every call; earlier tokens stay redacted after a rotation.
// `extra` holds file-based logins read at startup (the saved Claude token).
export function createRedactor(
  secrets: Secrets,
  root: string,
  currentKickToken: () => string | undefined = () => undefined,
  extra: (string | undefined)[] = [],
) {
  const base = [
    ...privateValues(secrets),
    ...extra.filter((value): value is string => !!value),
  ];
  const minted: string[] = [];
  let known = redactor(base, root);
  const clean: ReturnType<typeof redactor> = (value, limit, streaming) => {
    const live = currentKickToken();
    if (live && !minted.includes(live)) {
      minted.push(live);
      known = redactor([...base, ...minted], root);
    }
    return known(value, limit, streaming);
  };
  return { clean, privateValues: base };
}
