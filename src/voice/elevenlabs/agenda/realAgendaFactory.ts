/**
 * Factory for the ElevenLabs bridge in `real_readonly` mode.
 *
 * The template ships no production booking backend, so this mode fails
 * closed at startup instead of silently falling back to synthetic data.
 * To enable it, implement `ReadOnlyAgendaPort` (see `./port.ts`) on top of
 * your own calendar adapter and return it here.
 */
import type { ElevenLabsRealAgendaConfig } from "./config.js";
import type { ReadOnlyAgendaPort } from "./port.js";

export function createRealReadOnlyAgenda(_config: ElevenLabsRealAgendaConfig): ReadOnlyAgendaPort {
  throw new Error(
    "ELEVENLABS_BRIDGE_AGENDA_MODE=real_readonly needs a read-only agenda adapter; none ships with the template (see src/voice/elevenlabs/agenda/realAgendaFactory.ts)",
  );
}
