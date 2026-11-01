import { AsyncLocalStorage } from "node:async_hooks";

/**
 * step PROD (Hito 7) — per-request measurements that cannot travel in a
 * handler's return value.
 *
 * The mission needs four things in every access log line: a `request_id`, the
 * total duration, the duration spent waiting on the upstream Symfony API, and
 * a categorical result. Three of those the HTTP layer can see on its own. The
 * upstream time cannot: it is spent several layers below the route, inside
 * `LegacyRestClient`, which has no reference to the request that triggered it and
 * must not grow one (it is deliberately stateless — see its class comment).
 *
 * `AsyncLocalStorage` is what closes that gap without threading a context
 * object through every service signature. The store is established once per
 * request in `src/plugins/observability.ts` and the axios interceptors in
 * `src/clients/legacyRestClient.ts` add to whatever store happens to be current.
 *
 * Deliberately NOT in here: anything caller-specific. No phone, no name, no
 * headers, no bodies, no token. This module exists to measure time and count
 * calls, and that is all it is allowed to hold — an object that travels
 * implicitly with every async hop is exactly the wrong place to put PII,
 * because nothing downstream can see that it is carrying any.
 */
export interface RequestMetrics {
  /** Correlation id echoed to the caller and printed in the access line. */
  readonly requestId: string;
  /** Accumulated wall time of every upstream HTTP call this request made. */
  upstreamMs: number;
  /** How many upstream calls this request made (login included). */
  upstreamCalls: number;
  /** How many of those failed with a timeout / no response at all. */
  upstreamTimeouts: number;
}

const storage = new AsyncLocalStorage<RequestMetrics>();

export function createRequestMetrics(requestId: string): RequestMetrics {
  return { requestId, upstreamMs: 0, upstreamCalls: 0, upstreamTimeouts: 0 };
}

/** Runs `fn` (and everything it awaits) with `metrics` as the current store. */
export function runWithRequestMetrics<T>(metrics: RequestMetrics, fn: () => T): T {
  return storage.run(metrics, fn);
}

/** The current request's metrics, or undefined outside a request (e.g. boot). */
export function currentRequestMetrics(): RequestMetrics | undefined {
  return storage.getStore();
}

/**
 * Adds one upstream call to the current request's totals.
 *
 * A no-op when there is no current request. That is intentional and load
 * bearing: `AuthTokenService` refreshes a token lazily and could in principle
 * do so outside any request, and background work must never be able to crash
 * because it had nothing to attribute its timing to.
 */
export function recordUpstreamCall(durationMs: number, timedOut = false): void {
  const metrics = storage.getStore();
  if (metrics === undefined) return;
  metrics.upstreamMs += durationMs;
  metrics.upstreamCalls += 1;
  if (timedOut) metrics.upstreamTimeouts += 1;
}
