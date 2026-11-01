/**
 * Call-engine conversation state machine. Purely declarative: a fixed list
 * of states and a fixed table of legal transitions between them. Nothing in
 * this module executes any business logic — `engine.ts` is the only module
 * that decides *when* to move from one state to another; this module only
 * decides whether that move is *allowed*.
 *
 * Loosely inspired by (internal doc, not included in the template), adapted to
 * the exact 14-state list required by this mission. Two gates are kept
 * deliberately separate, per that document's invariant #3: confirming
 * *which* service (collected as data, in `RECOGER_DATOS`) is a different
 * step from confirming that the service is really wanted
 * (`CONFIRMACION_DE_SERVICIO`) and, for a booking, from confirming the
 * booking itself (`CONFIRMACION_EXPLICITA_DE_RESERVA`). A technical default
 * can populate the *value* of a field; it can never satisfy either
 * confirmation gate.
 */

export const STATES = [
  "INICIO",
  "ENMARCAR_DEMO",
  "ENTENDER_INTENCION",
  "ACLARAR_UNA_VEZ",
  "RECOGER_DATOS",
  "VALIDAR_DATOS",
  "CONSULTAR_DISPONIBILIDAD",
  "CONFIRMACION_DE_SERVICIO",
  "CONFIRMACION_EXPLICITA_DE_RESERVA",
  "ESCRITURA_SINTETICA",
  "EMITIR_RESUELVE",
  "EMITIR_DERIVA",
  "EMITIR_RECHAZA",
  "FIN",
] as const;

export type EngineState = (typeof STATES)[number];

/** Hard cap on agent-initiated turns in one synthetic call. See engine.ts. */
export const MAX_TURNS = 12;

/**
 * The legal-transition table. Read as "from -> [allowed next states]".
 * `canTransition` below is the ONLY thing that consults this table — it is
 * intentionally not exported, so nothing outside this module can bypass
 * `canTransition`'s check-and-report shape.
 *
 * Design notes on non-obvious edges:
 *  - `ENTENDER_INTENCION -> EMITIR_RECHAZA`, `RECOGER_DATOS -> EMITIR_RECHAZA`,
 *    `CONFIRMACION_DE_SERVICIO -> EMITIR_RECHAZA` and
 *    `CONFIRMACION_EXPLICITA_DE_RESERVA -> EMITIR_RECHAZA` are the paths to
 *    `RECHAZA`: a security/privacy boundary (or an explicit/urgent human
 *    request, or a CANCEL/RESCHEDULE/PRICE_OR_POLICY/SPECIAL_SERVICE
 *    utterance) can surface not only at the very first intent
 *    classification but on ANY later turn too — see engine.ts's
 *    `checkMidCallShortCircuit`, added precisely so a caller cannot dodge
 *    this boundary by waiting until data collection or a confirmation gate
 *    to reveal it (step 13 correction report, finding B1). Each of those
 *    three data-collection/confirmation states already had an
 *    `EMITIR_DERIVA` edge; only `EMITIR_RECHAZA` was missing.
 *  - `RECOGER_DATOS -> RECOGER_DATOS` is a deliberate self-loop: the engine
 *    asks for one missing field (service, then day, then time, then
 *    professional — see engine.ts) per pass through this state.
 *  - `ACLARAR_UNA_VEZ` is shared by three distinct single-retry gates
 *    (intent, service confirmation, booking confirmation) and returns to
 *    whichever state asked for the retry, or gives up to `EMITIR_DERIVA`.
 */
const TRANSITIONS: Readonly<Record<EngineState, readonly EngineState[]>> = {
  INICIO: ["ENMARCAR_DEMO"],
  ENMARCAR_DEMO: ["ENTENDER_INTENCION"],
  ENTENDER_INTENCION: ["ACLARAR_UNA_VEZ", "RECOGER_DATOS", "EMITIR_DERIVA", "EMITIR_RECHAZA"],
  ACLARAR_UNA_VEZ: [
    "ENTENDER_INTENCION",
    "CONFIRMACION_DE_SERVICIO",
    "CONFIRMACION_EXPLICITA_DE_RESERVA",
    "EMITIR_DERIVA",
  ],
  RECOGER_DATOS: ["RECOGER_DATOS", "VALIDAR_DATOS", "EMITIR_DERIVA", "EMITIR_RECHAZA"],
  VALIDAR_DATOS: ["CONSULTAR_DISPONIBILIDAD", "EMITIR_DERIVA"],
  CONSULTAR_DISPONIBILIDAD: ["CONFIRMACION_DE_SERVICIO", "EMITIR_DERIVA"],
  CONFIRMACION_DE_SERVICIO: [
    "ACLARAR_UNA_VEZ",
    "CONFIRMACION_EXPLICITA_DE_RESERVA",
    "EMITIR_RESUELVE",
    "EMITIR_DERIVA",
    "EMITIR_RECHAZA",
  ],
  CONFIRMACION_EXPLICITA_DE_RESERVA: [
    "ACLARAR_UNA_VEZ",
    "ESCRITURA_SINTETICA",
    "EMITIR_DERIVA",
    "EMITIR_RECHAZA",
  ],
  ESCRITURA_SINTETICA: ["EMITIR_RESUELVE", "EMITIR_DERIVA"],
  EMITIR_RESUELVE: ["FIN"],
  EMITIR_DERIVA: ["FIN"],
  EMITIR_RECHAZA: ["FIN"],
  FIN: [],
};

/** Whether the transition `from -> to` is declared legal. Anything undeclared is rejected. */
export function canTransition(from: EngineState, to: EngineState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Structural "no dead ends" guarantee: true iff `FIN` is reachable from
 * `state` by following only legal transitions (a plain BFS over
 * `TRANSITIONS`). `FIN` itself trivially reaches `FIN`. Used by
 * tests/callEngine/engine.test.ts to prove — once, over the whole table,
 * rather than per-scenario — that this state machine can never strand a
 * call.
 */
export function reachesFinFrom(state: EngineState): boolean {
  if (state === "FIN") return true;
  const seen = new Set<EngineState>([state]);
  const queue: EngineState[] = [state];
  while (queue.length > 0) {
    const current = queue.shift() as EngineState;
    for (const next of TRANSITIONS[current]) {
      if (next === "FIN") return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
