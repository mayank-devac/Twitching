export function redactor(secrets: string[], privateRoot: string) {
  const hidden = secrets
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length);
  const prefixes = [...hidden, privateRoot].filter(Boolean);
  const tokenPrefixes = ["sk-", "ghp_", "jv_live_", "eyJ"];
  const pathPrefixes = ["/Users/", "/home/", "/workspace/.home"];
  return (value: string, limit = 1400, streaming = false) => {
    let text = value
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    for (const secret of hidden) text = text.split(secret).join("[redacted]");
    text = text.split(privateRoot).join("[workspace]");
    text = text
      .replace(/(?:Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk-|ghp_|jv_live_)[A-Za-z0-9_-]+/g, "[redacted]")
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
        "[redacted]",
      )
      .replace(
        /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi,
        "$1[redacted]",
      )
      .replace(
        /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"'<>]+/gi,
        "[private path]",
      )
      .replace(/\/workspace\/\.home[^\s"'<>]*/g, "[private CLI data]");
    if (streaming) {
      // An unfinished JWT is not matched by the complete-token expression above.
      text = text.replace(/\beyJ[A-Za-z0-9_.-]*$/, "");
      let hold = 0;
      for (const prefix of [...prefixes, ...tokenPrefixes]) {
        const max = Math.min(text.length, prefix.length - 1);
        for (let length = max; length > hold; length--)
          if (text.endsWith(prefix.slice(0, length))) {
            hold = length;
            break;
          }
      }
      for (const prefix of tokenPrefixes)
        if (text.endsWith(prefix)) hold = Math.max(hold, prefix.length);
      const lower = text.toLowerCase();
      for (const prefix of pathPrefixes) {
        for (let length = Math.min(text.length, prefix.length); length > hold; length--)
          if (lower.endsWith(prefix.slice(0, length).toLowerCase())) {
            hold = length;
            break;
          }
      }
      if (hold) text = text.slice(0, -hold);
    }
    return text.slice(0, limit);
  };
}
export function credentialGuard(secrets: string[]) {
  const known = secrets.filter((value) => value.length >= 4);
  // Only credential values/shapes count. Ordinary variable names such as
  // secret or password are not evidence that a page contains credentials.
  const token =
    /\b(?:sk-|ghp_|jv_live_)[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/i;
  return (html: string): void => {
    if (known.some((value) => html.includes(value)) || token.test(html)) {
      throw new Error("Preview refused: generated HTML contains credentials");
    }
  };
}
export function failureKind(text: string): "usage" | "auth" | "other" {
  if (
    /usage.limit|rate.limit|quota.exceed|limit.reached|insufficient.quota|too many requests|429/i.test(
      text,
    )
  )
    return "usage";
  if (
    /unauth|not.logged|login.required|log.in|authentication|expired.token|invalid.token|invalid.api.key|oauth.token.(?:has.)?(?:expired|revoked)|401|403/i.test(
      text,
    )
  )
    return "auth";
  return "other";
}
