import { renderBookingAppJs } from "../../src/bookingWeb/ui.js.js";
import type { FakeDocument } from "./fakeDom.js";

/**
 * Técnica de extracción para probar el JavaScript de cliente
 * (`src/bookingWeb/ui.js.ts`) sin un navegador de verdad — el MISMO patrón
 * que `tests/console/uiClientExtract.ts` (que esta misión prohíbe importar),
 * copiado a propósito y adaptado a esta fase 2.
 *
 * Se toma el TEXTO EXACTO que `renderBookingAppJs()` sirve por `GET /app.js`
 * —el mismo que ejecutaría un navegador real— y se le añade, justo ANTES del
 * cierre de su propia IIFE, una línea que copia las funciones internas que
 * hacen falta a un objeto que devuelve esta función. No se modifica ni una
 * sola línea de la lógica original: sólo se EXPONE lo que ya existe. Si
 * `ui.js.ts` cambiara el nombre de una de estas funciones o dejara de
 * declararla en el ámbito superior de la IIFE, esta extracción fallaría con
 * un error claro (variable no definida), nunca en silencio.
 *
 * `fetch` se inyecta como PARÁMETRO de la función envolvente (igual que
 * `document`): el cliente real llama a `fetch('/api/…')` contra este mismo
 * proceso, y las pruebas la puentean a `app.inject()` de Fastify en vez de
 * abrir un socket — nunca a una red de verdad.
 */

const HOOK_NAMES = [
  "state",
  "wireControls",
  "init",
  "goToStep",
  "renderServiceStep",
  "selectService",
  "renderEmployeeStep",
  "selectEmployee",
  "renderCalendar",
  "changeMonth",
  "renderDayChips",
  "selectDate",
  "loadAvailability",
  "groupSlots",
  "blockTitle",
  "renderSlots",
  "selectSlot",
  "renderPaymentSection",
  "onPaymentChange",
  "confirmBooking",
  "renderConfirmation",
  "startOver",
  "switchView",
  "loadDashboard",
  "renderDashboard",
  "openResetDialog",
  "confirmReset",
  "monthMatrix",
  "formatDateLong",
  "formatMinutes",
  "horizonBounds",
  "nextIdempotencyKey",
] as const;

/** Un inicio ofrecible, tal y como lo publica `/availability` en `starts`. */
export interface UiStartOption {
  startMinutes: number;
  label: string;
}

/** Un tramo de apertura, tal y como lo publica `/availability` en `windows`. */
export interface UiOpeningWindow {
  index: number;
  startMinutes: number;
  endMinutes: number;
  label: string;
  rangeLabel: string;
}

/**
 * Lo que `groupSlots` necesita de la respuesta de `/availability`. Se retipa
 * aquí (en vez de dejarlo en `unknown`) porque la agrupación visual es justo
 * lo que estas pruebas comparan campo a campo: una prueba que le pasa un
 * objeto sin `windows` tiene que romperse al escribirla, no al ejecutarla.
 */
export interface AvailabilityShape {
  starts: UiStartOption[];
  windows: UiOpeningWindow[];
  stepMinutes?: number;
  durationMinutes?: number;
}

/** Un bloque de la rejilla: su tramo (o `null`) y los inicios que caen dentro. */
export interface UiSlotBlock {
  window: UiOpeningWindow | null;
  starts: UiStartOption[];
}

export type UiTestHooks = {
  state: {
    tenantId: string;
    bootstrap: Record<string, unknown> | null;
    view: string;
    step: number;
    serviceId: number | null;
    employeeId: number | null;
    date: string | null;
    startMinutes: number | null;
    fullDayView: boolean;
    paymentOption: string | null;
    idempotencyKey: string | null;
    lastBooking: Record<string, unknown> | null;
    lastMessages: string[];
    dashboard: Record<string, unknown> | null;
    /** La ÚLTIMA respuesta de `/availability`, tal cual llegó (con sus `windows`). */
    availability: AvailabilityShape | null;
  };
  wireControls: () => void;
  init: () => Promise<void>;
  goToStep: (n: number) => void;
  renderServiceStep: () => void;
  selectService: (serviceId: number) => void;
  renderEmployeeStep: () => void;
  selectEmployee: (employeeId: number) => void;
  renderCalendar: () => void;
  changeMonth: (delta: number) => void;
  renderDayChips: () => void;
  selectDate: (iso: string) => void;
  loadAvailability: () => Promise<void>;
  groupSlots: (avail: AvailabilityShape) => UiSlotBlock[];
  blockTitle: (group: UiSlotBlock) => string;
  renderSlots: () => void;
  selectSlot: (employeeId: number, startMinutes: number) => void;
  renderPaymentSection: () => void;
  onPaymentChange: (value: string) => void;
  confirmBooking: () => Promise<void>;
  renderConfirmation: () => void;
  startOver: () => void;
  switchView: (view: "reserva" | "dashboard") => void;
  loadDashboard: () => Promise<void>;
  renderDashboard: () => void;
  openResetDialog: () => void;
  confirmReset: () => Promise<void>;
  monthMatrix: (year: number, month1: number) => Array<Array<string | null>>;
  formatDateLong: (iso: string) => string;
  formatMinutes: (mins: number) => string;
  horizonBounds: () => { first: string; last: string };
  nextIdempotencyKey: () => string;
};

function patchedSource(): string {
  const jsSource = renderBookingAppJs();
  const marker = "})();\n";
  const lastIdx = jsSource.lastIndexOf(marker);
  if (lastIdx === -1) {
    throw new Error(
      "No se ha encontrado el cierre esperado de la IIFE de app.js ('})();\\n'). " +
        "La extracción de pruebas depende de esta forma exacta del fichero fuente.",
    );
  }
  const hookCode = `window.__txbTestHooks = { ${HOOK_NAMES.map((n) => `${n}: ${n}`).join(", ")} };\n`;
  return jsSource.slice(0, lastIdx) + hookCode + jsSource.slice(lastIdx);
}

/**
 * Ejecuta el JavaScript REAL servido por `/app.js` contra el `document` falso
 * que se le pase, con `fetch` puenteado a lo que decida la prueba (típicamente
 * `app.inject()` de Fastify), y devuelve las funciones internas expuestas por
 * el hook.
 *
 * `document.readyState` del `FakeDocument` nace en `"loading"` (ver
 * `fakeDom.ts`), así que el arranque real de `ui.js.ts` sólo REGISTRA el
 * listener de `DOMContentLoaded` y no llama a `init()` por su cuenta: la
 * prueba decide cuándo arrancar llamando a `hooks.init()` una única vez y
 * esperando la promesa que devuelve, en vez de competir con una llamada
 * automática.
 */
export function loadUiClientHooks(
  document: FakeDocument,
  fetchImpl: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json: () => Promise<unknown> }>,
): UiTestHooks {
  const patched = patchedSource();
  const stubWindow: { __txbTestHooks?: UiTestHooks } = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- ver el docblock: es la MISMA fuente que /app.js sirve, con un hook de exportación añadido sólo para la prueba.
  const fn = new Function("document", "window", "fetch", patched);
  fn(document, stubWindow, fetchImpl);
  if (!stubWindow.__txbTestHooks) {
    throw new Error("El hook de pruebas no se instaló: revisa HOOK_NAMES en uiClientExtract.ts.");
  }
  return stubWindow.__txbTestHooks;
}
