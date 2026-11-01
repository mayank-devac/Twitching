import React, { useRef, useState } from "react";
import type { QuickPreferences } from "../../shared/settings.js";
import { breakVisualObjectFit } from "../../shared/settings.js";
import { hostRequest } from "./api.js";
import { useHostAction, useHostQuery } from "../use-host-action.js";
type Asset = { id: string; name: string; type: string; bytes: number };
type Defaults = Record<"audio" | "visual", { name: string; url?: string }>;

// The eye button mounts a preview on demand; closing it also stops preview audio.
function Eye({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {open && <path d="m3 3 18 18" />}
    </svg>
  );
}
// Upload names are labels; the server keeps opaque IDs as the only media addresses.
export function BreakMedia({
  token,
  value,
  change,
  disabled,
  onBusy,
}: {
  token: string;
  value: QuickPreferences["media"];
  change(value: QuickPreferences["media"]): void;
  disabled: boolean;
  onBusy(value: boolean): void;
}) {
  const [files, setFiles] = useState<Asset[]>([]);
  const [defaults, setDefaults] = useState<Defaults>({
    audio: { name: "break.mp3", url: "/media/break.mp3" },
    visual: { name: "break-visual.gif", url: "/media/break-visual.gif" },
  });
  const [preview, setPreview] = useState<"audio" | "visual">();
  const { busy, error, setError, run } = useHostAction();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // A token change or closing this tab drops a late library response.
  useHostQuery(
    token,
    () => hostRequest<{ files: Asset[]; defaults?: Defaults }>(token, "/api/break-media"),
    (r) => {
      setFiles(r.files);
      if (r.defaults) setDefaults(r.defaults);
    },
    () => setError("Could not load saved media"),
  );
  async function upload(file?: File) {
    if (!file) return;
    setError("");
    if (file.size > 12 * 1024 * 1024) {
      setError("Choose a file smaller than 12 MB");
      return;
    }
    // The parent's busy flag is always released, even if this tab closed meanwhile.
    onBusy(true);
    await run(async () => {
      const asset = await hostRequest<Asset>(token, "/api/break-media", file, "POST", {
        raw: true,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
        },
        error: "Upload failed",
      });
      setFiles((old) => [...old, asset]);
      change({
        ...value,
        [asset.type.startsWith("audio/") ? "audio" : "visual"]: asset.id,
      });
      setPreview(undefined);
    }, "Upload failed");
    onBusy(false);
  }
  return (
    <section className="qs-card">
      <div className="qs-section-heading">
        <div>
          <h2>Break media</h2>
          <p className="qs-hint">
            Choose music and a visual for the break screen.
          </p>
        </div>
        <span className="qs-badge">12 MB / file</span>
      </div>
      <div className="qs-media-grid">
        {(["audio", "visual"] as const).map((kind) => {
          const selected = files.find((f) => f.id === value[kind]);
          const url = value[kind]
            ? `/media/break/${value[kind]}`
            : defaults[kind].url;
          const open = preview === kind;
          return (
            <article className="qs-media-tile" key={kind}>
              <div className="qs-row">
                <h3>{kind === "audio" ? "Music" : "GIF or image"}</h3>
                <button
                  type="button"
                  className="qs-icon-button"
                  aria-label={`${open ? "Hide" : "Show"} ${kind === "audio" ? "music" : "visual"} preview`}
                  title={open ? "Hide preview" : "Preview media"}
                  aria-expanded={open}
                  onClick={() => setPreview(open ? undefined : kind)}
                >
                  <Eye open={open} />
                </button>
              </div>
              <label className="qs-sr-only" htmlFor={`break-${kind}`}>
                {kind === "audio" ? "Break music" : "Break visual"}
              </label>
              <select
                id={`break-${kind}`}
                disabled={disabled || busy}
                value={value[kind] ?? ""}
                onChange={(e) => {
                  change({ ...value, [kind]: e.target.value || undefined });
                  setPreview(undefined);
                  setError("");
                }}
              >
                <option value="">{defaults[kind].name}</option>
                {value[kind] && !selected && (
                  <option value={value[kind]}>{value[kind]} (missing)</option>
                )}
                {files
                  .filter((f) =>
                    f.type.startsWith(kind === "audio" ? "audio/" : "image/"),
                  )
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name || f.id}
                    </option>
                  ))}
              </select>
              <div className="qs-media-meta">
                <span>
                  {selected
                    ? `${Math.ceil(selected.bytes / 1024)} KB`
                    : value[kind]
                      ? "File unavailable"
                      : "Default file"}
                </span>
                {value[kind] && (
                  <button
                    className="qs-text-button"
                    disabled={disabled || busy}
                    onClick={() => {
                      change({ ...value, [kind]: undefined });
                      setPreview(undefined);
                    }}
                  >
                    Reset
                  </button>
                )}
              </div>
              {kind === "visual" && (
                <label className="qs-visual-fit">
                  Visual display
                  <select
                    value={value.visualFit ?? "fit"}
                    disabled={disabled || busy}
                    onChange={(event) =>
                      change({
                        ...value,
                        visualFit: event.target
                          .value as QuickPreferences["media"]["visualFit"],
                      })
                    }
                  >
                    <option value="fit">Fit · show the whole image</option>
                    <option value="center">Center · original size</option>
                    <option value="fill">Fill · cover the screen</option>
                  </select>
                </label>
              )}
              {open && (
                <div className="qs-media-preview">
                  {kind === "visual" && (
                    <button
                      type="button"
                      className="qs-preview-expand"
                      onClick={(event) => {
                        const element = event.currentTarget.parentElement;
                        if (!element?.requestFullscreen) {
                          setError(
                            "Full screen is unavailable in this browser",
                          );
                          return;
                        }
                        void element
                          .requestFullscreen()
                          .catch(() =>
                            setError(
                              "Full screen is unavailable in this browser",
                            ),
                          );
                      }}
                    >
                      Full screen
                    </button>
                  )}
                  {kind === "audio" ? (
                    <audio
                      controls
                      preload="metadata"
                      src={url}
                      onError={() =>
                        setError("Cannot play this file. Choose another track.")
                      }
                    />
                  ) : value.visual ? (
                    <img
                      alt={selected?.name ?? "Selected break image"}
                      style={{ objectFit: breakVisualObjectFit[value.visualFit ?? "fit"] }}
                      src={url}
                      onError={() =>
                        setError(
                          "Cannot display this image. Choose another file.",
                        )
                      }
                    />
                  ) : url ? (
                    <img
                      alt="Default break GIF preview"
                      style={{ objectFit: breakVisualObjectFit[value.visualFit ?? "fit"] }}
                      src={url}
                      onError={() => setError("Default GIF is unavailable")}
                    />
                  ) : (
                    <p>Default preview unavailable.</p>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {/* Drop and picker share exactly the same bounded upload and validation path. */}
      <label
        className={`qs-upload${dragging ? " qs-dragging" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled && !busy) {
            dragDepth.current++;
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = disabled || busy ? "none" : "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (disabled || busy) return;
          if (event.dataTransfer.files.length !== 1) {
            setError("Drop one media file at a time");
            return;
          }
          void upload(event.dataTransfer.files[0]);
        }}
      >
        <span>
          <b>Drop a file here or choose a file</b>
          <small>Audio, GIF, PNG, JPEG or WebP</small>
        </span>
        <input
          type="file"
          accept=".png,.jpg,.jpeg,.gif,.webp,.mp3,.wav,.ogg"
          disabled={disabled || busy}
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      <details className="qs-details">
        <summary>Formats and playback</summary>
        <p>
          MP3, WAV, Ogg audio, GIF, PNG, JPEG or WebP. Up to 64 files, 12 MB
          each. Save settings to apply a new selection. Reset restores the
          default file; uploads stay in your library. Preview music plays only
          when you press Play.
        </p>
      </details>
      {busy && <p role="status">Uploading…</p>}
      {error && (
        <p className="qs-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
