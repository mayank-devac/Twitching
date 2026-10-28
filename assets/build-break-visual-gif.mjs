#!/usr/bin/env node
/**
 * Renders assets/break-visual.html into assets/break-visual.gif.
 *
 * The page draws each frame into a single 64x64 ImageData array and blits it
 * with putImageData, so this script stubs the DOM, runs the page's own script,
 * captures that array per frame using a fixed blink schedule, and encodes the
 * result with ffmpeg.
 *
 * Usage: node assets/build-break-visual-gif.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(here, "break-visual.html");
const outGif = path.join(here, "break-visual.gif");
const W = 64; // art resolution in the HTML
const SCALE = 4; // 64px -> 256px gif

const scriptSource = fs
  .readFileSync(htmlPath, "utf8")
  .match(/<script>([\s\S]*)<\/script>/)[1];

/**
 * Runs the page script with DOM stubs and returns [{delay, data}] frames.
 * render(b) is defined by the page script; putImageData is intercepted.
 */
function buildFrames() {
  return new Function(`
    const captured = [];
    const document = {
      getElementById: () => ({
        style: {},
        onclick: null,
        textContent: "",
        getContext: () => ({
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: (img) => captured.push(new Uint8ClampedArray(img.data)),
        }),
      }),
    };
    const addEventListener = () => {};
    const innerWidth = 260, innerHeight = 320;
    const requestAnimationFrame = () => {}; // loop replaced by fixed schedule
    ${scriptSource}
    // open 13 | close (ease-in, mirrors page pow curve) | hold | open | open 13
    const seq = [];
    for (let i = 0; i < 13; i++) seq.push({ b: 0, delay: 90 });
    seq.push({ b: Math.pow(0.3, 1.7), delay: 36 });
    seq.push({ b: Math.pow(0.6, 1.7), delay: 36 });
    seq.push({ b: Math.pow(0.85, 1.7), delay: 36 });
    seq.push({ b: 1, delay: 50 });
    for (const p of [0.2, 0.4, 0.6, 0.8]) seq.push({ b: (1 - p) ** 2, delay: 40 });
    for (let i = 0; i < 13; i++) seq.push({ b: 0, delay: 90 });
    return seq.map((f) => {
      captured.length = 0;
      render(f.b);
      return { delay: f.delay, data: captured[0] };
    });
  `)();
}

const frames = buildFrames();
console.log(`rendered ${frames.length} frames`);

// ---- nearest-neighbor upscale to PPM, concat list, ffmpeg -> gif -----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "breakv-"));
try {
  const header = Buffer.from(`P6\n${W * SCALE} ${W * SCALE}\n255\n`);
  const ppm = (i) => path.join(tmp, `f_${String(i).padStart(3, "0")}.ppm`);
  frames.forEach((f, i) => {
    // data layout is RGBA rows of width W
    const body = Buffer.alloc(W * SCALE * W * SCALE * 3);
    let o = 0;
    for (let y = 0; y < W * SCALE; y++) {
      const sy = ((y / SCALE) | 0) * (W * 4);
      for (let x = 0; x < W * SCALE; x++) {
        const j = sy + ((x / SCALE) | 0) * 4;
        body[o++] = f.data[j];
        body[o++] = f.data[j + 1];
        body[o++] = f.data[j + 2];
      }
    }
    fs.writeFileSync(ppm(i), Buffer.concat([header, body]));
  });

  // concat needs the last frame repeated to get its duration
  const list = path.join(tmp, "list.txt");
  fs.writeFileSync(
    list,
    frames
      .map((f, i) => `file '${ppm(i)}'\nduration ${(f.delay / 1000).toFixed(3)}`)
      .concat(`file '${ppm(frames.length - 1)}'\n`)
      .join("\n"),
  );

  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-vf",
    `[0:v]split[a][b];[a]palettegen=stats_mode=diff:reserve_transparent=0[p];[b][p]paletteuse=dither=none`,
    "-loop",
    "0",
    outGif,
  ]);
  console.log(`wrote ${outGif}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
