import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePromptList,
  promptPlaylistEnabled,
} from "../server/prompt-playlist.js";

test("parsePromptList keeps tasks and drops comments, blanks, and short lines", () => {
  assert.deepEqual(
    parsePromptList(
      "# heading\n\nBuild a colourful garden with flower controls\nshort\n  \n# skip\nBuild a tiny neon piano with clickable keys\n",
    ),
    [
      "Build a colourful garden with flower controls",
      "Build a tiny neon piano with clickable keys",
    ],
  );
});

test("promptPlaylistEnabled follows the file, --prompts, and --no-prompts", () => {
  const tasks = ["Build a colourful garden with flower controls"];
  assert.equal(promptPlaylistEnabled(tasks, {}), true);
  assert.equal(promptPlaylistEnabled([], {}), false);
  assert.equal(promptPlaylistEnabled([], { ARENA_PROMPTS: "1" }), true);
  assert.equal(promptPlaylistEnabled(tasks, { ARENA_NO_PROMPTS: "1" }), false);
  assert.equal(
    promptPlaylistEnabled(tasks, { ARENA_PROMPTS: "1", ARENA_NO_PROMPTS: "1" }),
    false,
  );
});
