import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  cliLoginCommand,
  cliStartupAdvice,
  failedLoginAgent,
} from "../server/cli-startup-repair.js";
import { Docker } from "../server/docker.js";
import { Store } from "../server/store.js";

test("Codex login repair targets the arena in both modes; native Cursor stays native", () => {
  for (const mode of ["native", "docker"] as const)
    assert.deepEqual(cliLoginCommand("codex", mode), {
      program: "npm",
      args: ["run", "sandbox:login:codex"],
    });
  assert.deepEqual(cliLoginCommand("cursor", "native"), {
    program: "cursor-agent",
    args: ["login"],
  });
  assert.deepEqual(cliLoginCommand("cursor", "docker"), {
    program: "npm",
    args: ["run", "sandbox:login:cursor"],
  });
});

test("permission, ownership, model and config errors never offer login repair", () => {
  for (const error of [
    Object.assign(new Error("kill EPERM"), { code: "EPERM" }),
    Object.assign(new Error("Permission denied reading a CLI profile"), {
      code: "EACCES",
    }),
    new Error("Cannot verify ownership of native process group 123456"),
    new Error("Native process group did not stop; no new round can start"),
    new Error("Invalid native process record; inspect it before restarting"),
    new Error("requested model is unavailable to the installed Codex/account"),
    new Error(
      "Installed Codex CLI lacks required isolation control --ignore-user-config",
    ),
    new Error("Native CLI check timed out"),
  ])
    assert.equal(cliStartupAdvice(error, "native").canRepair, false);
  assert.match(
    cliStartupAdvice(new Error("kill EPERM"), "native").instruction,
    /not a login failure/,
  );
});

test("confirmed missing login offers the correct instructions and a missing auth folder is recognised", () => {
  const advice = cliStartupAdvice(
    new Error("Codex arena login is missing"),
    "native",
  );
  assert.equal(advice.canRepair, true);
  assert.equal(advice.agent, "codex");
  assert.match(advice.instruction, /npm run sandbox:login:codex/);
  assert.doesNotMatch(advice.instruction, /Cursor:/);
  const cursor = cliStartupAdvice(
    new Error("Cursor must use saved subscription login"),
    "native",
  );
  assert.equal(cursor.canRepair, true);
  assert.equal(cursor.agent, "cursor");
  assert.match(cursor.instruction, /cursor-agent login/);
  assert.doesNotMatch(cursor.instruction, /sandbox:login:codex/);
  const missingCursor = Object.assign(new Error("missing folder"), {
    code: "ENOENT",
    path: "/fixture/runtime/auth/cursor",
  });
  assert.equal(failedLoginAgent(missingCursor), "cursor");
  const folder = cliStartupAdvice(missingCursor, "docker");
  assert.equal(folder.canRepair, true);
  assert.equal(folder.agent, "cursor");
  assert.match(folder.instruction, /sandbox:login:cursor/);
  assert.doesNotMatch(folder.instruction, /sandbox:login:codex/);
  assert.equal(
    cliStartupAdvice(
      Object.assign(new Error("missing CLI"), {
        code: "ENOENT",
        path: "/fixture/bin/codex",
      }),
      "docker",
    ).canRepair,
    false,
  );
});

test("docker Cursor workspace names a missing login instead of ENOENT", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "stram-docker-auth-"));
  const store = new Store(":memory:");
  const docker = new Docker(store, { root, image: "unused" });
  try {
    await assert.rejects(docker.workspace("cursor", 1), /sandbox:login:cursor/);
    store.close();
    store.close();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
