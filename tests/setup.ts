import nock from "nock";

/**
 * H1 — global test-harness safety net.
 *
 * Before this file existed, ONLY the test files that remembered to call
 * `nock.disableNetConnect()` themselves were protected from making real
 * outbound HTTP calls when a test forgot to install (or accidentally
 * removed) a `nock` interceptor. `tests/balancedV2Discover.test.ts` was the
 * proof: `nock.cleanAll()` with no interceptor reinstalled let an unmatched
 * request fall through to the REAL network — a live `POST
 * https://booking.example.com/v1/login` against the salon's production API on
 * every `npm test`, and a flaky ~5s hang whenever that call was slow.
 *
 * This runs once per test file (vitest's `setupFiles`, one per worker/file)
 * and disables real network connections by default for EVERY suite. It does
 * not change behaviour for the many files that already call
 * `nock.disableNetConnect()` / `nock.enableNetConnect()` themselves in their
 * own `beforeEach`/`afterEach` — those calls simply layer on top of this
 * default. Verified safe repo-wide: no test file issues a real HTTP client
 * request (`fetch`/`axios`/`http.request` to an `http(s)://` URL); the local
 * "server" tests (console, elevenlabs synthetic bridge) only ever use
 * Fastify's in-process `app.inject()` or a raw `net.createServer()` probe to
 * find a free port — neither opens an outbound connection nock would see.
 */
nock.disableNetConnect();
