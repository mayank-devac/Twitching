import { randomBytes } from "node:crypto";
import { CHAT_PLATFORMS } from "../shared/settings.js";
import type { ChatMessage } from "../shared/types.js";

const NAMES = ["sim_ava", "sim_ben", "sim_cho", "sim_dev", "sim_eli", "sim_fay", "sim_gus", "sim_hal"];
const CHAT = ["hello from chat", "this stream is great", "lol that was fast", "first time here", "gg", "what are we building today", "love the colors", "can you go faster"];
const PROMPTS = [
  "!prompt build a calm rainy window with glowing neon puddles",
  "!prompt make a tiny solar system that orbits around a sleepy sun",
  "!prompt create a playful cat chasing a bouncing red ball",
  "!prompt draw a slow falling snow globe with a small wooden cabin",
];
const pick = <T>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]!;

// Fake viewers for rehearsal only: a mix of plain chat, !prompt lines and, when a
// blocked word is configured, one line that must be hidden or masked in the feed.
export function fakeChat(blockedWord?: string, count = 3): ChatMessage[] {
  return Array.from({ length: count }, () => {
    const roll = Math.random();
    const text =
      blockedWord && roll < 0.15 ? `well ${blockedWord} that was unexpected` : roll < 0.5 ? pick(PROMPTS) : pick(CHAT);
    const author = pick(NAMES);
    return {
      id: `sim-${randomBytes(6).toString("hex")}`,
      platform: pick(CHAT_PLATFORMS),
      authorId: author,
      author,
      text,
      timestamp: Date.now(),
      membership: { verified: false, member: false, gift: false },
    };
  });
}
