import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Filter } from "../server/filter.js";
import type { ChatMessage } from "../shared/types.js";

const settings = JSON.parse(
  readFileSync(new URL("../settings.json", import.meta.url), "utf8"),
);
// Explicit test data keeps filter checks independent of the user's settings.
const filter = new Filter(["fuck", "bitch", "shit", "chutiya", "madarchod", "asshole"]);
const check = (text: string, blocked = filter) => {
  const message: ChatMessage = {
    id: "1",
    platform: "youtube",
    authorId: "a",
    author: "A",
    text,
    timestamp: 1,
    membership: { verified: false, member: false, gift: false },
  };
  return blocked.check(message);
};
const errorOf = (text: string, blocked = filter) => {
  const result = check(text, blocked);
  return "error" in result ? result.error : "";
};

test("settings allow a user-owned blocklist and no allowlist", () => {
  assert.ok(Array.isArray(settings.blockedWords));
  assert.equal("allowWords" in settings, false);
});

test("an empty blocklist accepts a readable prompt", () => {
  assert.equal(errorOf("!prompt Create a colourful bouncing ball", new Filter([])), "");
});

test("English, technical and lookalike-safe wording passes", () => {
  for (const text of [
    "!prompt Create a small garden for Mayank",
    "!prompt Create WebGL effects with CSS for Mayank",
    "!prompt Draw a peacock in a cocktail glass tonight",
    "!prompt Show the classic assassin movie poster now",
    "!prompt Grow shiitake beside a document and glasses",
    "!prompt Spell scunthorpe and assume nothing else",
    "!prompt A hancock gamecock studies chutney today",
    "!prompt Snigger at the Nigeria travel poster idea",
    "!prompt Charles Dickens wrote a colourful ghost story",
    "!prompt Build a colourful compass for the pirate ship",
    "!prompt Paint a pussycat on a country shift tonight",
    "!prompt Create a colourful family 👨‍👩‍👧 game tonight",
    "!prompt Build one qxqzzz small bouncing ball",
  ])
    assert.equal(errorOf(text), "", text);
});

test("blocked stems, inflections, masks and spaced letters fail", () => {
  const stem = new Filter(["fuck"]);
  for (const text of [
    "!prompt Create a fuck ball animation",
    "!prompt Create a FUCK ball animation",
    "!prompt Create a \uFF46\uFF55\uFF43\uFF4B ball animation",
    "!prompt Create a fu\u0441k ball animation",
    "!prompt Create a fu\u00adck ball animation",
    "!prompt Create a f\u200Buck ball animation",
    "!prompt Create a fucking ball animation",
    "!prompt Create a fuuuuck ball animation",
    "!prompt Create a fuuuucking ball animation",
    "!prompt Create a f.u.c.k ball animation",
    "!prompt f u c k this idea now please",
    "!prompt fu ck this idea now please",
    "!prompt Create a colourful fuc k game",
    "!prompt Create a colourful fu cking game",
    "!prompt Create a colourful f.u.c k game",
  ])
    assert.equal(errorOf(text, stem), "Blocked abusive language", text);
  for (const text of [
    "!prompt Create a f4ck ball animation",
    "!prompt Create a f*ck ball animation",
    "!prompt Create an 8itch ball animation",
    "!prompt Create a sh1t ball animation",
    "!prompt Create a chutiya ball animation",
    "!prompt Create some bitches ball animation",
    "!prompt Make a motherfucker robot dance now",
    "!prompt Create a colourful bit ch game",
    "!prompt Create a colourful chu tiya garden",
    "!prompt Create a colourful chut iya garden",
    "!prompt Create a colourful madar chod garden",
    "!prompt Create a colourful ass hole garden",
  ])
    assert.equal(errorOf(text), "Blocked abusive language", text);
});

test("vowel-containing junk, short junk, non-English suggestions and repetition are rejected", () => {
  for (const text of [
    "!prompt qqaqq wweww rrerr ttytt uuquu",
    "!prompt qq ww rr tt xx",
    "!prompt Build a blorptastic zzyzx terrarium today",
    "!prompt Sundar rang birangi khel banayo abhi",
  ])
    assert.equal(errorOf(text), "Too many unreadable words", text);
  for (const text of [
    "!prompt game game game game game",
    "!prompt a a a a a",
    "!prompt Build build BUILD build colourful cards",
  ])
    assert.equal(errorOf(text), "Repeated-word spam", text);
});

test("shape checks still reject short, symbolic, mashed and control text", () => {
  assert.equal(
    errorOf("Create a colourful bouncing ball"),
    "Use !prompt followed by your idea",
  );
  assert.equal(
    errorOf("!prompt four little words only"),
    "At least five words are needed",
  );
  assert.equal(
    errorOf("!prompt 😀 🎁 🎉 👾 ✨"),
    "At least five words are needed",
  );
  assert.equal(
    errorOf("!prompt hi hi hi hi hi 😀😀😀😀😀😀😀😀😀😀"),
    "Mostly symbols, emoji, links, or non-English text",
  );
  assert.equal(
    errorOf("!prompt gibberish qqqzzz xxxzzz rrrqqq jjjhhh"),
    "Too many unreadable words",
  );
  assert.equal(
    errorOf("!prompt Create a colourful\u0000 ball animation"),
    "Unreadable control characters",
  );
  assert.equal(
    errorOf(`!prompt ${"colourful ".repeat(80)}`),
    "Prompt exceeds 600 characters",
  );
});

test("a passed prompt drops the prefix and invisible characters", () => {
  const result = check("!prompt Create a colourful f\u200Bamily game tonight");
  assert.ok(!("error" in result));
  if (!("error" in result)) {
    assert.equal(result.text, "Create a colourful family game tonight");
    assert.equal(result.normalized, "create a colourful family game tonight");
  }
});
