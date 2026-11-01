# Local, loopback-only demonstration

A procedure for running this middleware on a developer machine and exercising
all five `/ai/*` tools by hand, without any public exposure, DNS, TLS, or
nginx. This is **not** the production pre-launch checklist — that is
(internal doc, not included in the template) §7, gated on
G-A/G-B. This document has no authority over those gates and does not bring
you any closer to clearing them; it only lets you see the middleware respond
to the exact request shapes an ElevenLabs agent would send, on your own
machine.

## Preconditions

- `ENABLE_WRITE_OPERATIONS=false` — verify this in your local `.env` before
  starting. With it `false`, `/ai/book` and `/ai/cancel` run every check but
  never write upstream (`src/services/bookingService.ts`,
  `src/services/cancellationService.ts`).
- The server binds to `127.0.0.1` only (`HOST=127.0.0.1` in `.env`, or the
  default if you leave it unset — check `.env.example`). No nginx, no reverse
  proxy, no TLS, no public port.
- Nothing here is reachable from outside your machine. If you are on a VPS,
  do this over an SSH tunnel or on a local workstation, not on a box with a
  public IP and an open port.

## 1. Create a local `.env`

```bash
cp .env.example .env
```

Then **open `.env` in your editor** and fill in the values by hand. Do not
use `cat`, `echo`, or any command that would print the file's contents to
your terminal or into a chat/AI session — that defeats the point of keeping
it local.

- `BOOKING_USERNAME` / `BOOKING_PASSWORD`: for a fully offline demo (§4 below)
  these can stay blank; the app only needs them if it actually calls the
  upstream. For the loopback-with-real-reads demo (§3) they must be a real,
  approved credential — see the two-tier warning below.
- `BOOKING_DEFAULT_OWNER_ID` / `_OWNER_NAME` / `_OWNER_SURNAMES`: these may
  stay **commented out**. A blank/absent owner id no longer blocks boot
  (`src/config/env.ts`); it only matters if a write is actually attempted,
  and writes are off by default.
- `ENABLE_WRITE_OPERATIONS`: leave as `false`.
- `ENABLE_MULTI_BARBER`: leave as `false` unless you specifically want to
  exercise the multi-barber response shape (see the note in §3).

## 2. Generate a local webhook secret

```bash
openssl rand -hex 32
```

Paste the output into `AI_WEBHOOK_SECRET=` in your editor. **Do not paste
this value into chat, a commit, an issue, or any document** — it is a local
secret for your own test run, and once written down anywhere else it should
be treated as compromised and regenerated.

Then, in your shell only (not in a file), export it so the `curl` examples
below can read it without you retyping it:

```bash
export AI_WEBHOOK_SECRET="$(grep '^AI_WEBHOOK_SECRET=' .env | cut -d= -f2-)"
```

This reads the value from your local `.env` into your shell's environment; it
does not print it to the screen.

## 3. Start the service

```bash
npm ci
npm run build
npm start
# or, for a dev server with reload:
npm run dev
```

First check — no auth, no upstream call:

```bash
curl -s http://127.0.0.1:3000/health
```

Expect an HTTP 200 with a small JSON body (see `src/routes/health.ts` if you
want the exact shape — not reproduced here since it is not an `/ai/*` tool).

### The five tools

All examples target `127.0.0.1:3000` and read the secret from the shell
environment set in §2. Replace `2026-07-29` with a real future date if you
want a non-empty availability result against a real upstream (§3 only makes
sense once real credentials are configured; skip straight to §4 otherwise).

```bash
curl -s http://127.0.0.1:3000/ai/availability \
  --header "X-AI-Webhook-Secret: $AI_WEBHOOK_SECRET" \
  --header 'Content-Type: application/json' \
  -d '{ "date": "2026-07-29", "preferredTime": "17:00", "maxSlots": 4 }'
```
Expected shape:
```json
{ "available": true,
  "message": "Tengo hueco el miércoles 29 de julio a las 16:30, 17:00 y 18:00. ¿Cuál prefieres?",
  "slots": [ { "start": "2026-07-29 16:30:00", "label": "16:30" } ] }
```

```bash
curl -s http://127.0.0.1:3000/ai/check-slot \
  --header "X-AI-Webhook-Secret: $AI_WEBHOOK_SECRET" \
  --header 'Content-Type: application/json' \
  -d '{ "reservationDate": "2026-07-29 17:00:00" }'
```
Expected shape: `{ "available": true, "message": "Sí, está libre a las 17:00." }`

```bash
curl -s http://127.0.0.1:3000/ai/book \
  --header "X-AI-Webhook-Secret: $AI_WEBHOOK_SECRET" \
  --header 'Content-Type: application/json' \
  -d '{ "customer": { "name": "Carlos", "surnames": "García", "phone": "+34600000001" },
        "reservationDate": "2026-07-29 17:00:00",
        "confirmedByCustomer": true }'
```
With `ENABLE_WRITE_OPERATIONS=false` (the precondition above), expect
`success: false` with the Spanish "no puedo cerrar la reserva por teléfono"
message and `reason: "write_disabled"` — **not** an error, HTTP 200. This is
the correct, deliberate demo outcome: it proves the kill-switch works, not
that a booking happened.

```bash
curl -s http://127.0.0.1:3000/ai/my-reservations \
  --header "X-AI-Webhook-Secret: $AI_WEBHOOK_SECRET" \
  --header 'Content-Type: application/json' \
  -d '{}'
```
Expected shape, with `BOOKING_UPSTREAM_MODE` left at its default (`legacy`) — the correct,
fail-closed local demo outcome, reached BEFORE any caller identity is even resolved:
```json
{ "outcome": "unsupported",
  "message": "Ahora mismo no puedo consultar ni cancelar reservas por teléfono. Te recomiendo llamar directamente a la peluquería para que lo revisen contigo." }
```
This is not a demo limitation — it is the shipped, deliberately fail-closed behaviour
((internal doc, not included in the template) §5.3): in `legacy` mode the
`/v1/ai/*` endpoints do not exist upstream at all, so this middleware never even attempts to
resolve a caller identity or call out. The RETIRED `customerPhone` request field is gone
regardless of mode: `find_my_reservations` no longer accepts a caller-supplied phone number
at all — the only optional field is `fromDate` (`YYYY-MM-DD`) — because the phone used for a
lookup must be a telephony-verified caller identity, never a value transcribed from speech.
Reaching `identity_missing`, `one_match`, `no_match`, or `ambiguous` locally requires setting
`BOOKING_UPSTREAM_MODE=ai` and, for anything past `identity_missing`, also configuring a
caller-identity trust mode (`AI_CALLER_ID_TRUST_MODE`, default `none`; `synthetic_test` is the
mode meant for exactly this kind of local exercise) — see
(internal doc, not included in the template) §4 and `tests/lookup.test.ts` /
`tests/callerIdentity.test.ts` for worked, fully offline examples. This document does not walk
through configuring either: doing so safely needs the same care as any other upstream-mode or
trust-mode change and is out of scope for a "start the server and curl it" demo. **ElevenLabs
and the telephony provider are not configured and must not be contacted at any point in this
procedure.**

```bash
curl -s http://127.0.0.1:3000/ai/cancel \
  --header "X-AI-Webhook-Secret: $AI_WEBHOOK_SECRET" \
  --header 'Content-Type: application/json' \
  -d '{ "reservationRef": "aB3dE6fG9hJ1kL4mN7pQ0rS2tU5vW8xY", "confirmedByCustomer": true, "callerStatedName": "Carlos" }'
```
The RETIRED `reservationId` (a raw numeric legacy id) is gone — `cancel_appointment` now
takes `reservationRef` (a 32-character opaque reference, obtainable only from a prior
`find_my_reservations` `one_match`, never invented locally), `confirmedByCustomer`, and
`callerStatedName`. With `BOOKING_UPSTREAM_MODE` at its default (`legacy`), expect the same
`unsupported` outcome shown above — cancellation fails closed identically to lookup, before
any identity resolution, write, or upstream call.

If you want to see the multi-barber response shape (`employeeId`/
`employeeName` on slots and on check-slot), set `ENABLE_MULTI_BARBER=true`
and restart before running the same commands — see
(internal doc, not included in the template) for what that changes
in the conversation.

## Two-tier network warning — read before running §3 against real credentials

There are two different levels of risk here, and it is easy to conflate them:

1. **The two read-only tools that still call upstream** (`/ai/availability`,
   `/ai/check-slot`) reach the real upstream Demo Salon API the moment real
   `BOOKING_USERNAME`/`BOOKING_PASSWORD` are configured, regardless of
   `ENABLE_WRITE_OPERATIONS`. They are reads, but they are real reads against
   Bruno's live system. `/ai/my-reservations` and `/ai/cancel` are the
   exception with `BOOKING_UPSTREAM_MODE` left at its default (`legacy`, see
   §3 above): both answer `unsupported` before any upstream call is made, so
   they are safe to call against real credentials too, as long as
   `BOOKING_UPSTREAM_MODE` stays `legacy`. Setting `BOOKING_UPSTREAM_MODE=ai`
   changes this — both routes then genuinely call `/v1/ai/*` upstream once a
   caller identity resolves — and is a separate, deliberate step this
   document does not walk through (see §3 above).
2. **`/ai/book` and `/ai/cancel` also reach the real upstream for their
   availability re-check / barber-resolution phase** even with
   `ENABLE_WRITE_OPERATIONS=false` — see the ordering in
   `src/services/bookingService.ts:73-145`: (1) confirmation check, (2)
   availability re-check / barber resolution — an upstream read — (3) the
   write kill-switch, (4) owner-id check, (5) the actual write. The
   kill-switch stops the write at step 3; it does not stop the read at step
   2. So even a "safe" `/ai/book` demo against real credentials still calls
   `/user/employees-day` and `/user/free` on the real system.

**Running this against real credentials is making real requests to Bruno's
live system.** That is not something this document authorises — it requires
the same approval (Gate G-B) as any other live-credential use in this
project. For a demonstration that needs no approval and touches no network at
all, use §4.

## 4. Fully offline option — zero network, zero approval needed

```bash
npm test
```

The test suite exercises all five flows (availability, check-slot, book,
my-reservations, cancel) plus the multi-barber variants against mocked HTTP
responses, with real network access disabled at the socket level
(`nock.disableNetConnect()`). Nothing leaves the machine, no credentials are
needed, and no approval gate applies. This is the genuinely zero-risk way to
show the request/response contracts working end to end.

## What a stakeholder demo proves / does not prove

**Proves:**
- The five tool contracts documented in
  [TOOL_SCHEMAS.json](TOOL_SCHEMAS.json) match what the running service
  actually accepts and returns.
- The Spanish phrasing is what a caller would hear.
- The write kill-switch genuinely blocks writes while still validating the
  rest of the flow (confirmation required, slot re-checked, etc).
- The offline test suite (§4) shows the same behaviour with zero risk and no
  credentials at all.

**Does not prove:**
- That the service works against a real phone call or a real ElevenLabs
  agent — no such call has been made (see [README.md](README.md)).
- That a real booking or cancellation succeeds upstream — writes were off for
  every example above.
- That the owner/account model is resolved — `BOOKING_DEFAULT_OWNER_ID` is
  still unset in production; see
  (internal doc, not included in the template) #1.
- Anything about production readiness, load, or public network exposure.
