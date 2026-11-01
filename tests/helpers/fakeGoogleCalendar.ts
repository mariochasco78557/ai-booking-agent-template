/**
 * Test alias: the in-memory Google Calendar emulator now lives in `src/` so the
 * `memory` calendar provider can reuse it for `npm run dev` without credentials.
 */
export * from "../../src/adapters/calendar/memory/inMemoryGoogleCalendar.js";
