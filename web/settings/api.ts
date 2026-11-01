// All host requests use the same cookie/CSRF protection as the original control panel.
export interface HostRequestOptions {
  // Send `body` as-is (an upload) instead of JSON-encoding it; set its type in `headers`.
  raw?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  // Shown when a failed response carries no `error` of its own.
  error?: string;
}
export async function hostRequest<T>(
  token: string,
  path: string,
  body?: unknown,
  method = "POST",
  { raw = false, headers, signal, error = "Request failed" }: HostRequestOptions = {},
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : method,
    signal,
    headers: {
      "X-Host-Token": token,
      ...(body === undefined || raw ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? error);
  return result as T;
}
