// Names must be workspace-relative; hidden paths, parent traversal and credential names stay private.
export function safeFileName(path: string): string | undefined {
  const relative = path.replace(/^\/workspace\//, "");
  if (relative.startsWith("/") || relative.includes("\\")) return undefined;
  const parts = relative.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part.startsWith(".") ||
        !/^[a-zA-Z0-9 _@()+-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(part),
    )
  )
    return undefined;
  const name = parts.at(-1)!;
  if (
    /auth|credential|secret|private.?key|keystore|\.(pem|key|p12|pfx)$/i.test(
      relative,
    )
  )
    return undefined;
  return name;
}
