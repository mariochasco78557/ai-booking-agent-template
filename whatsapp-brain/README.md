# whatsapp-brain

WhatsApp channel of the booking agent. It receives customer messages (from a WhatsApp
Business provider webhook), runs a Claude tool-calling loop and talks to the booking
middleware only through typed tools (`booking_availability_balanced_v*`,
`booking_create_booking_balanced_v*`, `booking_mis_citas`, `booking_cancelar_cita`,
`booking_cambiar_servicio`, `avisar_a_owner`). It never touches the calendar directly.

- `src/prompt.ts` + `prompts/`: system prompt (cacheable, identical across calls) and business rules.
- `src/tools.ts`: tool schemas sent to the model; `tests/` pins them against the middleware contract.
- `src/conversation.ts`: per-conversation state, serialisation, history limits.
- `src/sim.ts`: local simulator (no WhatsApp provider needed).

```bash
cd whatsapp-brain
npm ci --ignore-scripts
npm test          # 18 files, 277 tests, no network
npm run build && npm run sim
```

Configuration is by environment variables (see `src/config.ts`); secrets never go in git.
