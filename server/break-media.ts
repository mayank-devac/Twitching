import { randomBytes } from "node:crypto";
import type { Store } from "./store.js";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";

export const mediaId = /^[a-f0-9]{32}\.(mp3|wav|ogg|png|jpg|gif|webp)$/;
const mime: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
// Inspect bytes rather than trusting a filename or a browser-supplied MIME type.
export function detectMedia(b: Buffer): string {
  if (b.length < 16) throw new Error("Media file is empty or incomplete");
  if (
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    b.subarray(-8, -4).toString() === "IEND"
  )
    return "png";
  if (
    b[0] === 255 &&
    b[1] === 216 &&
    b[2] === 255 &&
    b[b.length - 2] === 255 &&
    b[b.length - 1] === 217
  )
    return "jpg";
  if (
    /^GIF8[79]a$/.test(b.subarray(0, 6).toString()) &&
    b[b.length - 1] === 59 &&
    b.readUInt16LE(6) > 0 &&
    b.readUInt16LE(8) > 0
  )
    return "gif";
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.readUInt32LE(4) + 8 === b.length
  ) {
    const format = b.subarray(8, 12).toString();
    if (format === "WEBP") return "webp";
    if (format === "WAVE") return "wav";
  }
  if (
    b.subarray(0, 4).toString() === "OggS" &&
    b[4] === 0 &&
    (b.includes(Buffer.from("vorbis")) || b.includes(Buffer.from("OpusHead")))
  )
    return "ogg";
  let offset = 0;
  if (b.subarray(0, 3).toString() === "ID3") {
    if ([b[6], b[7], b[8], b[9]].some((n) => n > 127))
      throw new Error("Invalid MP3 tag");
    offset = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
  }
  if (
    offset + 4 < b.length &&
    b[offset] === 255 &&
    (b[offset + 1] & 224) === 224 &&
    (b[offset + 1] & 6) !== 0 &&
    (b[offset + 2] & 240) !== 0 &&
    (b[offset + 2] & 240) !== 240
  )
    return "mp3";
  throw new Error(
    "Use a valid PNG, JPEG, GIF, WebP, MP3, WAV or Ogg audio file",
  );
}
// Only opaque approved IDs resolve to files; neither upload names nor paths are used.
export class BreakMedia {
  private dir: string;
  private writing = false;
  constructor(
    private root: string,
    private store?: Store,
  ) {
    this.dir = resolve(root, "runtime/break-media");
  }
  private async ready() {
    for (const path of [resolve(this.root, "runtime"), this.dir]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(path)) !== path
      )
        throw new Error("Unsafe media directory");
    }
  }
  async list() {
    await this.ready();
    const names = (await readdir(this.dir)).filter((n) => mediaId.test(n));
    if (names.length > 64)
      throw new Error("Media library exceeds its 64-file limit");
    const files: { id: string; name: string; type: string; bytes: number }[] =
      [];
    for (const id of names) {
      const info = await lstat(resolve(this.dir, id));
      if (info.isFile() && !info.isSymbolicLink())
        files.push({
          id,
          name: this.store?.mediaName(id) ?? id,
          type: mime[id.split(".").pop()!],
          bytes: info.size,
        });
    }
    return files;
  }
  async path(id: string) {
    if (!mediaId.test(id)) throw new Error("Invalid media ID");
    await this.ready();
    const path = resolve(this.dir, id);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Media is unavailable");
    return { path, type: mime[id.split(".").pop()!] };
  }
  // A small fixed library and one bounded write prevent repeated uploads filling disk.
  async upload(bytes: Buffer, originalName = "") {
    if (this.writing) throw new Error("Another upload is in progress");
    this.writing = true;
    try {
      if (bytes.length > 12 * 1024 * 1024)
        throw new Error("Maximum upload size is 12 MB");
      const ext = detectMedia(bytes);
      const files = await this.list();
      if (files.length >= 64)
        throw new Error(
          "Media library is full (64 files); ask the host to remove unused files",
        );
      const id = `${randomBytes(16).toString("hex")}.${ext}`;
      const file = await open(resolve(this.dir, id), "wx", 0o600);
      try {
        await file.writeFile(bytes);
      } catch (error) {
        await unlink(resolve(this.dir, id)).catch(() => {});
        throw error;
      } finally {
        await file.close();
      }
      // A supplied filename is never a filesystem path and is rendered only as text.
      const name =
        originalName
          .split(/[\\/]/)
          .pop()
          ?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
          .trim()
          .slice(0, 120) || id;
      this.store?.saveMediaName(id, name);
      return { id, name, type: mime[ext], bytes: bytes.length };
    } finally {
      this.writing = false;
    }
  }
}
