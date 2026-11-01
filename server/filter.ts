import type { ChatMessage, Evaluation } from "../shared/types.js";
import nspell from "nspell";
import dictionary from "dictionary-en";

const english = nspell({
  aff: Buffer.from(dictionary.aff),
  dic: Buffer.from(dictionary.dic),
});
const TECHNICAL_WORDS = new Set([
  "ai",
  "ajax",
  "api",
  "ascii",
  "astro",
  "async",
  "await",
  "aws",
  "azure",
  "babylonjs",
  "bezier",
  "bitcrush",
  "blender",
  "boolean",
  "bootstrap",
  "bun",
  "canvas",
  "charizard",
  "chatgpt",
  "chiptune",
  "cli",
  "cloudflare",
  "cmyk",
  "codex",
  "comfyui",
  "cpu",
  "crt",
  "css",
  "csv",
  "cursor",
  "cyberpunk",
  "deno",
  "devops",
  "diablo",
  "discord",
  "dither",
  "docker",
  "dom",
  "dpi",
  "eevee",
  "em",
  "enum",
  "favicon",
  "figma",
  "firebase",
  "flexbox",
  "fortnite",
  "frontend",
  "fullstack",
  "gameboy",
  "gif",
  "github",
  "gitlab",
  "glitch",
  "glsl",
  "godot",
  "gpu",
  "gpt",
  "graphql",
  "grayscale",
  "grok",
  "gui",
  "hdr",
  "hlsl",
  "hsl",
  "hsla",
  "html",
  "http",
  "https",
  "hud",
  "ide",
  "iframe",
  "isometric",
  "javascript",
  "jev",
  "jpeg",
  "jpg",
  "jquery",
  "js",
  "json",
  "jsx",
  "keydown",
  "keyframe",
  "keyframes",
  "keyup",
  "kick",
  "kirby",
  "kubernetes",
  "llm",
  "localhost",
  "lowpoly",
  "mario",
  "mayank",
  "megaman",
  "metroidvania",
  "minecraft",
  "minimap",
  "ml",
  "mmorpg",
  "mongodb",
  "mousedown",
  "mouseup",
  "navbar",
  "neon",
  "netlify",
  "nextjs",
  "nginx",
  "nintendo",
  "npc",
  "npm",
  "nuxt",
  "nvidia",
  "obs",
  "oklab",
  "oklch",
  "openai",
  "overwatch",
  "pacman",
  "parallax",
  "phaser",
  "pikachu",
  "pixelart",
  "pixijs",
  "playstation",
  "png",
  "pnpm",
  "pokemon",
  "pokeball",
  "pong",
  "postgres",
  "powerup",
  "prisma",
  "px",
  "pygame",
  "ram",
  "react",
  "redis",
  "regex",
  "rem",
  "retro",
  "rgb",
  "rgba",
  "roblox",
  "roguelike",
  "rpg",
  "scanline",
  "sdk",
  "shader",
  "skyrim",
  "sokoban",
  "sonic",
  "speedrun",
  "sprite",
  "spritesheet",
  "sqlite",
  "srgb",
  "ssd",
  "starcraft",
  "steam",
  "supabase",
  "svelte",
  "svg",
  "synthwave",
  "tailwind",
  "tetris",
  "threejs",
  "tiktok",
  "tileset",
  "tooltip",
  "touchend",
  "touchstart",
  "tsx",
  "twitch",
  "typescript",
  "ui",
  "unity",
  "unreal",
  "uri",
  "url",
  "ux",
  "valorant",
  "vaporwave",
  "vercel",
  "vh",
  "vhs",
  "vite",
  "voxel",
  "vue",
  "vw",
  "warcraft",
  "wasm",
  "webgl",
  "webp",
  "webpack",
  "websocket",
  "xbox",
  "xml",
  "yaml",
  "yarn",
  "youtube",
  "zelda",
]);

const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
};
// These survive NFKC and are used to hide a Latin blocked word.
const CONFUSABLES: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ѕ: "s",
  α: "a",
  ε: "e",
  ι: "i",
  ο: "o",
  ρ: "p",
};
const SUFFIXES = ["ing", "ers", "er", "ed", "es", "ty", "s"];
// Longer chat suggestions are rejected before any Jev call is made.
export const MAX_PROMPT_CHARS = 600;

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function foldLetters(text: string) {
  let out = "";
  for (const ch of text.normalize("NFKC").toLowerCase())
    out += CONFUSABLES[ch] ?? ch;
  return out;
}

function abuseTokens(text: string) {
  const folded = foldLetters(text)
    .replace(/([a-z0-9])[^\sa-z0-9]+(?=[a-z0-9])/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const parts = folded ? folded.split(" ") : [];
  const tokens = [...parts];
  // Check neighbouring fragments regardless of each fragment's size: fuc k,
  // bit ch, and chu tiya must be treated like their unsplit forms.
  for (let i = 0; i < parts.length; i++) {
    let joined = "";
    for (let j = i; j < parts.length; j++) {
      joined += parts[j];
      if (joined.length > 16) break;
      if (j > i && joined.length >= 3) tokens.push(joined);
    }
  }
  return tokens;
}

function leet(token: string) {
  if (!/[a-z]/.test(token) || !/[0-9]/.test(token)) return token;
  return token.replace(/[0134578]/g, (c) => LEET[c] ?? c);
}

export class Filter {
  private readonly stems: Set<string>;
  private readonly fuzzy = new Map<string, RegExp[]>();
  constructor(blocked: string[]) {
    const stems = new Set<string>();
    for (const word of blocked) {
      const key = foldLetters(word).replace(/[^a-z0-9]/g, "");
      if (key.length >= 2) stems.add(key);
    }
    this.stems = stems;
    for (const stem of stems) {
      if (!/^[a-z]{3,}$/.test(stem)) continue;
      const pattern = new RegExp(
        `^${[...stem].map((ch) => `${ch}+`).join("")}$`,
      );
      const bucket = this.fuzzy.get(stem[0]) ?? [];
      bucket.push(pattern);
      this.fuzzy.set(stem[0], bucket);
    }
  }
  private stemHit(key: string) {
    if (this.stems.has(key)) return true;
    if (!/(.)\1/.test(key)) return false;
    return (
      this.fuzzy.get(key[0])?.some((pattern) => pattern.test(key)) ?? false
    );
  }
  private listed(key: string) {
    if (!key) return false;
    if (this.stemHit(key)) return true;
    for (const suffix of SUFFIXES) {
      if (
        key.length - suffix.length >= 3 &&
        key.endsWith(suffix) &&
        this.stemHit(key.slice(0, -suffix.length))
      )
        return true;
    }
    return false;
  }
  private abusive(token: string) {
    const key = token.replace(/[^a-z0-9]/g, "");
    return (
      this.listed(key) ||
      this.listed(leet(key).replace(/[^a-z]/g, "")) ||
      this.compound(key)
    );
  }
  // One masked letter (f*ck, f4ck) may stand for any letter of a listed stem.
  // Leet alone cannot cover it: 4 reads as "a", and "*" has no letter at all.
  private masked(token: string) {
    if (token.length < 4 || !/[a-z]/.test(token)) return false;
    if ((token.match(/[*0-9]/g) ?? []).length !== 1) return false;
    const bases = [
      token,
      ...SUFFIXES.filter(
        (suffix) => token.length - suffix.length >= 3 && token.endsWith(suffix),
      ).map((suffix) => token.slice(0, -suffix.length)),
    ];
    return bases.some((base) =>
      [...this.stems].some(
        (stem) =>
          stem.length === base.length &&
          [...base].every((ch, i) => /[*0-9]/.test(ch) || ch === stem[i]),
      ),
    );
  }
  // A dictionary word glued to a listed stem (motherfucker) is blocked. When
  // the whole token is itself English (peacock, gamecock) only an inflected
  // remainder counts, so plain compounds of an exact stem still pass.
  private compound(key: string) {
    if (key.length < 7 || !/^[a-z]+$/.test(key)) return false;
    const wholeWord = english.correct(key);
    for (let i = 3; i <= key.length - 4; i++) {
      if (!english.correct(key.slice(0, i))) continue;
      const rest = key.slice(i);
      if (this.stemHit(rest) ? !wholeWord : this.listed(rest)) return true;
    }
    return false;
  }
  check(
    message: ChatMessage,
  ): { text: string; normalized: string } | { error: string } {
    if (!/^!prompt\s/i.test(message.text))
      return { error: "Use !prompt followed by your idea" };
    const text = message.text
      .replace(/^!prompt\s+/i, "")
      .normalize("NFKC")
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\u00ad\ufeff]/g, "")
      .trim();
    if (text.length > MAX_PROMPT_CHARS)
      return { error: `Prompt exceeds ${MAX_PROMPT_CHARS} characters` };
    if (/[\u0000-\u001f\u007f]/.test(text))
      return { error: "Unreadable control characters" };
    const words = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?|\d+/g) ?? [];
    if (words.length < 5) return { error: "At least five words are needed" };
    if (
      abuseTokens(text).some((token) => this.abusive(token)) ||
      (foldLetters(text).match(/[a-z0-9*]+/g) ?? []).some((token) =>
        this.masked(token),
      )
    )
      return { error: "Blocked abusive language" };
    const letters = text.replace(/[^A-Za-z]/g, "").length;
    if (letters < text.replace(/\s/g, "").length * 0.6)
      return { error: "Mostly symbols, emoji, links, or non-English text" };
    const counts = new Map<string, number>();
    for (const word of words) {
      const key = word.toLowerCase();
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count / words.length >= 0.6) return { error: "Repeated-word spam" };
    }
    const readable = words.filter(
      (word) =>
        /^\d+$/.test(word) ||
        TECHNICAL_WORDS.has(word.toLowerCase()) ||
        english.correct(word) ||
        english.correct(word.toLowerCase()),
    ).length;
    if (readable / words.length < 0.8)
      return { error: "Too many unreadable words" };
    return { text, normalized: normalize(text) };
  }
}

export function rank(e: Evaluation, m: ChatMessage) {
  const base =
    e.simplicity * 0.4 +
    e.clarity * 0.25 +
    e.creativity * 0.2 +
    e.visual * 0.15;
  const bonus =
    m.platform !== "twitch" &&
    m.membership.verified &&
    !!m.membership.evidence &&
    (m.membership.member || m.membership.gift)
      ? 10
      : 0;
  return Math.round((base + bonus) * 100) / 100;
}
