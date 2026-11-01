# LEGACY — middleware histórico `/ai/*`

> **No usar esta carpeta para el producto vigente `callEngine` + consola.**
> Estos artefactos pertenecen al middleware histórico `/ai/*`. La integración
> nueva, sintética y aislada para el motor vigente se documenta en
> (internal doc, not included in the template).
> No mezcles esquemas, prompts ni rutas de ambas carpetas.

# ElevenLabs voice agent — prepared configuration (not deployed)

This directory holds the machine-facing artefacts needed to configure an
ElevenLabs (or compatible) voice agent against this middleware's `/ai/*`
endpoints. Everything here is preparation. **No provider account exists, no
agent has been configured, and no call has ever reached this service.**

The authoritative documents for the gates, secret handover, retry rules, IP
allowlisting, and the production pre-launch checklist remain
(internal doc, not included in the template) — this
directory does not repeat or replace it. The authoritative document for the
Spanish conversational flows and the multi-barber "hora primero, barbero
opcional" policy remains
(internal doc, not included in the template) — this directory does
not repeat or replace it either. Read both before using anything here.

## Contents

| File | What it is |
|---|---|
| [TOOL_SCHEMAS.json](TOOL_SCHEMAS.json) | Machine-readable definitions of the seven `/ai/*` tools. The two `/ai/voice/*` entries are the STAGING workflow contract for interval availability and confirmed booking; the other five preserve the earlier step 10C contract. Mirrors `src/schemas/aiSchemas.ts`; update it whenever those schemas change. |
| [AGENT_PROMPT_ES.md](AGENT_PROMPT_ES.md) | A copy-paste Spanish (Spain) system prompt for the agent itself — distinct from (internal doc, not included in the template), which is the human configuration guide the prompt is derived from. |
| [LOCAL_DEMO.md](LOCAL_DEMO.md) | A safe, loopback-only procedure for exercising all five tools by hand on a developer machine, plus a fully offline option via `npm test`. Not the production checklist. |
| (internal doc, not included in the template) | Current independent ElevenLabs workflow agent IDs, placeholder-tool warning, local verification evidence and remaining gates. Contains no secrets or customer data. |
| (internal doc, not included in the template) | **step SLOT.** The `slot_token` contract: what changed in both `/ai/voice/*` tools, the four new refusal outcomes, the two new environment variables, and the deployment/rollback plan. Read this BEFORE touching the ElevenLabs tool definitions — the middleware and the agent have to move together, and there is deliberately no window in which both contracts work at once. Not applied; pending external audit. |

## What has been done

> **step SLOT (2026-08-30) — the booking contract below is OUT OF DATE for
> `booking_create_booking`.** `reservation_date`, `employee_id` and `service_id`
> are no longer request fields; a `slot_token` issued by
> `booking_check_availability` replaces all three. `TOOL_SCHEMAS.json` is
> already updated; the ElevenLabs side is NOT. See
> (internal doc, not included in the template).

- The five `/ai/*` endpoints exist, are implemented, and pass the full
  automated test suite against mocked upstream responses (`npm test`).
- `find_my_reservations` and `cancel_appointment` were rebuilt for the
  caller-identity voice contract
  (internal doc, not included in the template). The caller is
  identified only by a telephony-verified caller identity the middleware
  resolves from headers (`src/callerIdentity/resolver.ts`) — never a phone
  number or reservation id the model transcribes from speech. The RETIRED
  request fields `customerPhone` (lookup) and `reservationId` (cancellation)
  are gone; `cancel_appointment` now takes `reservationRef` (obtainable only
  from a prior `find_my_reservations` `one_match`), `confirmedByCustomer`, and
  `callerStatedName`.
- **There is no transfer tool anywhere in this system, and there never has
  been.** The middleware can only ever say a human needs to look at something
  (`action: "human_assistance_required"`) — it never claims a call was moved,
  and the agent prompt is written to match that (see `AGENT_PROMPT_ES.md`).
  The RETIRED `action: "transfer_to_human"` value, and the "te paso con la
  peluquería" phrasing that went with it, are gone from the code and from
  this directory's documentation.
- Their request/response contracts are documented three times over: in the
  root `README.md`, in (internal doc, not included in the template) §4, and machine-readable
  in `TOOL_SCHEMAS.json` here, with `tests/voiceContract.test.ts` asserting
  the JSON, the Zod schemas, the route table, and the outcome unions all
  agree.
- A Spanish conversational flow and a Spanish agent system prompt have been
  drafted ((internal doc, not included in the template), `AGENT_PROMPT_ES.md`).

## What has NOT been done

- No ElevenLabs (or other voice provider) account has been created or
  configured, and **none is contacted by anything in this repository.**
- No API key for any voice provider has been generated, stored, or used.
- No phone number has been purchased or connected, and no telephony provider
  is configured or contacted.
- The service has never been exposed publicly — it is loopback-only, blocked
  on Gate G-A per (internal doc, not included in the template) §1.
- No real phone call has ever reached this middleware.
- No real booking or cancellation has ever been created via voice, or via
  any of the artefacts in this directory.
- `ENABLE_WRITE_OPERATIONS` and the owner-id prerequisite
  (`BOOKING_DEFAULT_OWNER_ID`) remain unresolved production blockers — see
  (internal doc, not included in the template) #1 and (internal doc, not included in the template) §1.
- **`AI_CALLER_ID_TRUST_MODE` defaults to `none`, and that default is not
  changed by anything here.** With `BOOKING_UPSTREAM_MODE=ai` and no
  caller-identity trust configured, both `find_my_reservations` and
  `cancel_appointment` answer `identity_missing` — fail closed, honestly,
  rather than guessing or fabricating a "no reservations" answer. Configuring
  a real trust mode (`provider_header` or `signed_envelope`) is a separate,
  deliberately gated step described in
  (internal doc, not included in the template) §4 — nothing in
  this directory does it, and it must not be enabled against a real deployment
  without going through that design's attestation requirements.
- `BOOKING_UPSTREAM_MODE` still defaults to `legacy`, under which both voice
  lookup and cancellation answer `unsupported` before any upstream call is
  made and before any caller identity is even resolved, regardless of
  `AI_CALLER_ID_TRUST_MODE`.

None of the files in this directory change that status. They exist so that,
once the gates in (internal doc, not included in the template) are cleared, the actual
provider configuration step is copy-and-adapt rather than starting from a
blank page.
