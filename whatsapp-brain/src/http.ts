/** Small JSON-over-HTTP helper with a hard timeout. Never throws on HTTP errors. */

export interface JsonResponse {
  status: number;
  /** Parsed body, or undefined when it was not JSON. */
  body: unknown;
}

export type FetchLike = typeof fetch;

export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: { method: "GET" | "POST" | "PUT"; headers?: Record<string, string>; body?: unknown; timeoutMs: number }
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: init.method,
      headers: {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export function errorCode(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.error === "string") return b.error;
    const e = b.error as Record<string, unknown> | undefined;
    if (e && typeof e === "object" && typeof e.code === "string") return e.code;
    if (typeof b.code === "string") return b.code;
  }
  return undefined;
}
