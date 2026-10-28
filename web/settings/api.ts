// All host requests use the same cookie/CSRF protection as the original control panel.
export async function hostRequest<T>(
  token: string,
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : method,
    headers: {
      "X-Host-Token": token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed");
  return result as T;
}
