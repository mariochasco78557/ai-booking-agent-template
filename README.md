# AI Booking Agent Template

A production-shaped template for **LLM booking agents** that take appointments over
**WhatsApp and the phone**. The language model talks to the customer and drafts the
answer; deterministic TypeScript code decides availability, identity, limits and every
write. It ships with a pluggable calendar layer (an in-memory demo backend and a Google
Calendar adapter), a deterministic call engine, an operator console, and a test suite of
**~5,000 tests that run offline in about 20 seconds**. All business data lives in one YAML
file per client, so a new client is a folder, not a fork.

> Everything in this repository is fictitious: "Demo Salon", its staff (Bruno, Olga,
> Ramón / Ana, Luis), phone numbers (`+34 600 000 0xx`, `+34 910 000 0xx`) and domains
> (`*.example.com`). No client data is included.

## Architecture

```mermaid
flowchart LR
  subgraph Channels
    WA[WhatsApp<br/>whatsapp-brain/]
    VO[Phone voice<br/>voice-agent/ (Pipecat + Twilio)]
    EL[ElevenLabs agent<br/>src/voice/elevenlabs]
  end
  subgraph Brain["LLM brain (drafts only)"]
    P[System prompt + business rules<br/>docs/elevenlabs, whatsapp-brain/prompts]
    T[Tool schemas<br/>strict JSON / Zod]
  end
  subgraph Core["Booking middleware (Fastify, src/) - code decides"]
    R[Tool routes /ai/*<br/>Zod validation, auth, rate limit]
    S[Services: availability, balanced offers,<br/>slot tokens, booking, cancel, lookup]
    G[Write gate + kill switches<br/>idempotency, per-phone limits]
    CE[Deterministic call engine<br/>src/callEngine]
  end
  subgraph Calendar["CalendarProvider port"]
    M[memory<br/>in-process emulator]
    GC[google-calendar<br/>service account]
    X[your adapter<br/>PMS / REST backend]
  end
  PS[(Persistence<br/>idempotency store, queues,<br/>agenda cache snapshot)]
  CFG[[clientes/&lt;id&gt;/cliente.yaml<br/>+ textos.yaml]]

  WA --> Brain
  VO --> Brain
  EL --> Brain
  Brain -- tool calls --> R
  R --> S --> G --> Calendar
  S --> CE
  G --> PS
  CFG -.-> Core
  CFG -.-> Brain
```

Request path for a booking: the model calls `availability` -> the server returns slots
plus a **signed slot token** -> the model reads options to the customer -> on explicit
confirmation it calls `book` echoing the token -> the server verifies the token, the
write switches, idempotency and per-phone limits, and only then writes to the calendar.

## Design principles

- **Code decides, the model drafts.** Identity, money, availability, sending and every
  write are decided by deterministic code. The model can only pick among options the
  server produced (slot tokens are HMAC-signed and short-lived).
- **Tool-calling with strict schemas.** Every tool input is validated with Zod
  (`src/schemas/`); unknown fields, personal data in the wrong place and malformed
  dates are rejected before any upstream call. Tool documents in `docs/elevenlabs/*.json`
  are pinned by contract tests.
- **Deterministic engine.** `src/callEngine/` models calendars, seasons, holidays,
  waitlists, no-shows and group bookings as pure functions with an injectable clock, so
  every conversation outcome is reproducible.
- **Golden-set tests.** Real-world failure cases become fixtures and literal-text tests
  (dates spoken aloud, "next Tuesday", DST changes, closed days, double-booking races).
- **Fail closed on ambiguity.** Missing config refuses to boot; ambiguous identity never
  reveals a booking; writes are off unless the master switch *and* the per-operation
  flag are on; uncertain writes are reported as uncertain, never as success.
- **One container per client.** Business data in `clientes/<id>/`, secrets in `.env`,
  same image for every client (`Dockerfile`, `compose.yaml`).
- **No silent failures.** Structured logs with masked personal data, request metrics,
  owner alerts (Telegram) and queued, retried WhatsApp confirmations.

## Quick start

```bash
git clone <this-repo> ai-booking-agent && cd ai-booking-agent
cp .env.example .env          # fill AI_WEBHOOK_SECRET and VOICE_SLOT_TOKEN_SECRET
npm ci
npm test                      # full suite, offline (network is disabled in tests/setup.ts)
npm run dev                   # http://localhost:3000, CALENDAR_PROVIDER=memory
```

Try a tool call against the in-memory calendar:

```bash
curl -s localhost:3000/health
curl -s -X POST localhost:3000/ai/availability \
  -H 'content-type: application/json' \
  -H "x-ai-webhook-secret: $AI_WEBHOOK_SECRET" \
  -d '{"date":"2026-11-03"}'
```

Other entry points: `npm run typecheck`, `npm run build && npm start`,
`npm run voice:elevenlabs:synthetic` (ElevenLabs tool bridge over a synthetic venue),
`npm run booking:web:demo` (customer booking page demo),
`tools/call-engine-demo/console.sh` (local operator console on 127.0.0.1:4310).

## Configure a new client

1. `cp -r clientes/_plantilla clientes/<client-id>`
2. Edit `cliente.yaml`: business name, sector wording, timezone, opening hours, closures,
   services (id, duration, price), employees and their calendars, channels, limits.
3. Optionally override customer-facing texts in `textos.yaml` (keys from
   `src/core/texts/defaultTexts.es.ts`; placeholders are validated at load time).
4. In `.env`: `CLIENT_ID=<client-id>` and the calendar backend
   (`CALENDAR_PROVIDER=memory` to try it, `google-calendar` + a service account for real).
   Step-by-step Google setup: `clientes/_plantilla/README.md`.
5. `npm test` (`tests/clientConfig.test.ts` validates the template schema), then boot with
   `ENABLE_WRITE_OPERATIONS=false` and check availability before enabling writes.

Precedence is always: environment variable > `cliente.yaml` > code default.
To connect another backend, implement `CalendarProvider` + `CalendarBackOffice`
(`src/core/calendar/CalendarProvider.ts`) under `src/adapters/calendar/<id>/` and run the
shared contract suite in `tests/calendarProviderContract.test.ts` against it.

## Test suite

| Package | Files | Tests | Runtime |
|---|---|---|---|
| Middleware (`tests/`) | 181 | 4,767 | ~20 s, no network |
| WhatsApp brain (`whatsapp-brain/tests`) | 18 | 277 | ~2 s |
| Voice agent (`voice-agent/tests`, pytest) | 15 | not run in CI here (needs `uv sync`) | |

Highlights: adversarial sweep (prompt/identity injection, oversized fields, replay),
write-gate state machine, slot-token authorization, double-booking concurrency, agenda
cache latency, spoken-date parsing across every weekday/hour, DST, transcript audit of
what the agent says, Google Calendar adapter against an in-memory fake, and contract
tests that pin tool schemas and prompts.

## Folder map

```
src/
  app.ts, index.ts         Fastify app and entry point
  routes/                  tool endpoints (/ai/*, balanced v2/v5, WhatsApp self-service, recados)
  schemas/                 Zod schemas for every tool input
  services/                availability, booking, cancellation, lookup, balanced offers,
                           slot authorization, idempotency, owner notifications, WhatsApp queue
  core/calendar/           CalendarProvider port + error contract
  core/config/, core/texts/ client config loader (cliente.yaml) and text layer
  adapters/calendar/       memory (default) and google-calendar adapters
  callEngine/              deterministic call/conversation engine (pure, clock-injected)
  callerIdentity/          caller-ID trust levels and session pinning
  voice/elevenlabs/        ElevenLabs tool bridge (synthetic agenda) + transcript audit
  console/                 local operator console (decisions, waitlist, no-shows)
  bookingWeb/              customer booking page demo
  config/env.ts            every environment variable, defaults and fail-closed rules
clientes/
  _plantilla/              template for a new client (YAML + .env.example + setup guide)
  demo-salon/              fictitious reference client used by tests and `npm run dev`
  ejemplo-google/          fictitious Google Calendar client (America/Mexico_City)
whatsapp-brain/            WhatsApp channel (Claude tool loop, prompts, own test suite)
voice-agent/               Python phone agent (Twilio + Pipecat + Deepgram + Claude)
docs/elevenlabs/           agent prompts and tool schemas (pinned by tests)
docs/call_interruption_mvp/, docs/operator_console/   specs the tests check against
tests/                     vitest suite (helpers/, fixtures/, integration/)
tools/call-engine-demo/    scripts for the local console demo
assets/brand/              placeholder logo for the demo UIs
```

Comments and customer-facing texts are in Spanish (the original market); identifiers and
this README are in English.

## License

MIT, see [LICENSE](LICENSE).

## Author

Mario Chasco · Flowara AI
