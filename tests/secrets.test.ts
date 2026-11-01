import test from "node:test";
import assert from "node:assert/strict";
import { createRedactor, privateValues } from "../server/secrets.js";

const secrets = {
  jev: "jev-secret-value",
  youtube: { access: "yt-access-1", refresh: "yt-refresh-1", client: "yt-client-1", secret: "yt-secret-1", chat: "yt-chat-1" },
  twitch: { access: "tw-access-1", refresh: "tw-refresh-1", client: "tw-client-1", secret: "tw-secret-1", broadcaster: "tw-cast-1", user: "tw-user-1" },
  kick: { access: "kick-access-1", broadcaster: "kick-cast-1", client: "kick-client-1", secret: "kick-secret-1" },
  obs: "obs-password-1",
};

test("privateValues covers every credential the server and launcher used to hide", () => {
  const values = privateValues(secrets);
  for (const value of [
    secrets.jev, secrets.youtube.access, secrets.youtube.refresh, secrets.youtube.secret,
    secrets.twitch.access, secrets.twitch.refresh, secrets.twitch.secret,
    secrets.kick.access, secrets.kick.secret, secrets.obs,
  ]) assert.ok(values.includes(value), value);
});

test("redactor hides a Kick token minted after startup, and keeps hiding earlier ones", () => {
  let live = "";
  const { clean } = createRedactor(secrets, "/private/root", () => live);
  live = "minted-kick-token-A";
  assert.equal(clean("failed with minted-kick-token-A"), "failed with [redacted]");
  live = "minted-kick-token-B";
  const out = clean("A=minted-kick-token-A B=minted-kick-token-B");
  assert.ok(!out.includes("minted-kick-token"), out);
});

test("redactor hides static secrets", () => {
  const { clean } = createRedactor(secrets, "/private/root");
  assert.ok(!clean(`token ${secrets.kick.client} ${secrets.obs}`).includes("obs-password-1"));
});
