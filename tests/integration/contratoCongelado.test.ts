import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PRECEDENCE_ORDER } from "../../src/callEngine/precedence.js";
import { INTERNAL_EVENT_NAMES, PILOT_EVENT_NAMES, PILOT_REASON_CODES } from "../../src/callEngine/events/schema.js";

/**
 * step 18 · fase H — criterios 8.26 y 8.27: EL CONTRATO CONGELADO, comprobado
 * contra el FICHERO, no sólo contra el código.
 *
 * Lo que ya existe y NO se repite aquí:
 *   · el orden literal de `PRECEDENCE_ORDER` y las listas de nombres de
 *     evento — `tests/console/waitlistApi.test.ts` §12.12 y
 *     `tests/callEngine/precedence.test.ts`;
 *   · que el esquema tiene diez códigos y que `BOOKING_NOT_CONFIRMED` no está
 *     entre ellos — `tests/callEngine/bookingNotConfirmed.test.ts`;
 *   · que `latencyMs` sigue siendo opcional — `tests/callEngine/latencyNotCollected.test.ts`.
 *
 * Lo que faltaba, y es lo que esta suite añade:
 *   1. una comprobación de INTEGRIDAD DEL FICHERO congelado (hash), para que
 *      una edición silenciosa del contrato v1 no pase inadvertida;
 *   2. el cruce en los TRES sentidos entre el enum del fichero,
 *      `PILOT_REASON_CODES` y `PRECEDENCE_ORDER`;
 *   3. la comparación LITERAL de `WaitlistAuditKind` (criterio 8.27, tercera
 *      cláusula), que es un tipo y por tanto no existe en tiempo de ejecución:
 *      se lee del fuente.
 */

const RAIZ = process.cwd();
const RUTA_ESQUEMA = join(RAIZ, "docs/call_interruption_mvp/pilot-event.schema.json");
const RUTA_MODELO_LISTA = join(RAIZ, "src/callEngine/waitlist/model.ts");

/**
 * El hash del contrato v1 tal y como quedó congelado. NO es un detalle de
 * implementación: es el contrato que un consumidor externo puede haber
 * implementado ya. Si esta prueba falla, alguien editó el fichero — y la
 * respuesta correcta es preguntar por qué, no actualizar el hash sin más.
 * Cambiarlo exige renegociar la versión del esquema (`schemaVersion`), no
 * tocar esta línea.
 */
const HASH_CONGELADO = "4136ec64ef02ae438a7a81342ec41deb6261c6b0c5c19895b6af29853b161bd7";

interface EsquemaCongelado {
  required: string[];
  properties: {
    schemaVersion: { const: string };
    eventName: { enum: string[] };
    reasonCode: { enum: string[] };
    outcome: { enum: string[] };
    synthetic: { const: boolean };
  };
}

const bytes = readFileSync(RUTA_ESQUEMA);
const esquema = JSON.parse(bytes.toString("utf8")) as EsquemaCongelado;

describe("step 18 · criterio 8.26 — el fichero del contrato v1 no se ha tocado", () => {
  it("el SHA-256 de docs/call_interruption_mvp/pilot-event.schema.json es el congelado", () => {
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(
      hash,
      "el contrato v1 congelado ha cambiado en disco: esto rompe a cualquier consumidor externo y exige renegociar schemaVersion, no actualizar este hash",
    ).toBe(HASH_CONGELADO);
  });

  it("y su contenido sigue diciendo lo mismo: versión 1.0.0, sintético siempre, y los seis campos obligatorios", () => {
    expect(esquema.properties.schemaVersion.const).toBe("1.0.0");
    expect(esquema.properties.synthetic.const).toBe(true);
    expect(esquema.required).toEqual([
      "schemaVersion",
      "eventId",
      "occurredAt",
      "callIdHash",
      "scenarioId",
      "eventName",
    ]);
    expect(esquema.properties.outcome.enum).toEqual(["RESUELVE", "DERIVA", "RECHAZA"]);
  });
});

describe("step 18 · criterio 8.27 — los diez códigos, en los tres sitios a la vez", () => {
  it("el enum del fichero, PILOT_REASON_CODES y PRECEDENCE_ORDER son EL MISMO conjunto de diez", () => {
    const delFichero = [...esquema.properties.reasonCode.enum].sort();
    const delCodigo = [...PILOT_REASON_CODES].sort();
    const delOrden = [...PRECEDENCE_ORDER].sort();
    expect(delFichero.length).toBe(10);
    expect(delCodigo).toEqual(delFichero);
    expect(delOrden).toEqual(delFichero);
  });

  it("PRECEDENCE_ORDER conserva su orden literal, que NO es el del fichero (y no tiene por qué serlo)", () => {
    expect([...PRECEDENCE_ORDER]).toEqual([
      "SECURITY_OR_PRIVACY_BOUNDARY",
      "TECHNICAL_FAILURE",
      "CUSTOMER_REQUESTS_HUMAN",
      "CANCEL_OR_CHANGE_NOT_ENABLED",
      "BUSINESS_DATA_NOT_APPROVED",
      "SLOT_OUTSIDE_SYNTHETIC_SCHEDULE",
      "SERVICE_NOT_CONFIRMED",
      "INTENT_NOT_UNDERSTOOD",
      "BOOKING_CONFIRMED",
      "AVAILABILITY_PROVIDED",
    ]);
    // El fichero ordena por familia y el motor por precedencia de decisión:
    // son dos órdenes distintos del mismo conjunto, a propósito.
    expect([...PRECEDENCE_ORDER]).not.toEqual(esquema.properties.reasonCode.enum);
  });

  it("los ocho nombres de evento del fichero son exactamente PILOT_EVENT_NAMES, y ninguno menciona nada de step 17 ni de step 18", () => {
    expect(esquema.properties.eventName.enum).toEqual([...PILOT_EVENT_NAMES]);
    const todos = [...PILOT_EVENT_NAMES, ...INTERNAL_EVENT_NAMES].join(" ");
    for (const ajeno of ["WAITLIST", "NO_SHOW", "GROUP", "CLOCK", "DEMO_RESET"]) {
      expect(todos, ajeno).not.toContain(ajeno);
    }
  });
});

/**
 * Los VEINTIDÓS de step 17, congelados en su orden literal. Esta lista NO se
 * toca: es el catálogo heredado, y si alguno desapareciese o cambiase de sitio
 * la historia del registro dejaría de poder releerse igual.
 */
const KINDS_HEREDADOS: readonly string[] = [
  "WAITLIST_ENTRY_CREATED",
  "WAITLIST_OPT_IN_DECLINED",
  "RESERVATION_CANCELLED_ON_TIME",
  "RESERVATION_CANCELLED_LATE",
  "LATE_CANCELLATION_REVIEWED",
  "SLOT_RELEASED",
  "SLOT_RELEASE_PRODUCED_NO_SLOTS",
  "WAITLIST_MATCH_EVALUATED",
  "WAITLIST_ENTRY_MATCHED",
  "WAITLIST_NOTICE_SIMULATED",
  "WAITLIST_OFFER_ACCEPTED",
  "WAITLIST_OFFER_DECLINED",
  "WAITLIST_OFFER_RELEASED",
  "WAITLIST_ENTRY_CONVERTED",
  "WAITLIST_CONVERSION_CONFLICT",
  "WAITLIST_CONVERSION_FAILED_INJECTED",
  "WAITLIST_ENTRY_WITHDRAWN",
  "WAITLIST_ENTRY_EXPIRED_MANUALLY",
  "WAITLIST_ENTRY_REOPENED",
  "CANCELLATION_POLICY_CHANGED",
  "IDEMPOTENT_REPLAY",
  "DEMO_RESET",
];

/**
 * step 23 §6 añade CINCO, y sólo puede añadirlos AL FINAL: el catálogo
 * heredado se comprueba aparte, elemento a elemento y en su orden, para que
 * "ampliar" no pueda usarse nunca como tapadera de "reescribir".
 */
const KINDS_DE_M_VPS_23: readonly string[] = [
  "WAITLIST_PROPOSAL_CREATED",
  "WAITLIST_PROPOSAL_APPROVED",
  "WAITLIST_PROPOSAL_SUBSTITUTED",
  "WAITLIST_PROPOSAL_INVALIDATED",
  "WAITLIST_PROPOSAL_NONE_AVAILABLE",
];

describe("step 18 · criterio 8.27 — WaitlistAuditKind sigue siendo el de step 17, literalmente", () => {
  /**
   * `WaitlistAuditKind` es un tipo: en tiempo de ejecución no existe, así que
   * la única forma honesta de comprobarlo es leyendo el fuente. Se extraen los
   * literales de la unión, en orden, y se comparan con la lista congelada.
   */
  function kindsDelFuente(): string[] {
    const fuente = readFileSync(RUTA_MODELO_LISTA, "utf8");
    const inicio = fuente.indexOf("export type WaitlistAuditKind =");
    expect(inicio, "ya no existe `export type WaitlistAuditKind` en waitlist/model.ts").toBeGreaterThan(-1);
    const fin = fuente.indexOf(";", inicio);
    expect(fin).toBeGreaterThan(inicio);
    const bloque = fuente.slice(inicio, fin);
    return [...bloque.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
  }

  it("los veintidós heredados, en el mismo orden y sin uno solo fuera de sitio", () => {
    // Se compara el PREFIJO: los veintidós de step 17 tienen que seguir
    // siendo los veintidós primeros, uno a uno.
    expect(kindsDelFuente().slice(0, KINDS_HEREDADOS.length)).toEqual(KINDS_HEREDADOS);
  });

  /**
   * step 23 §6. Ampliar el catálogo es legítimo; reescribirlo no. Por eso
   * esta prueba fija el TOTAL exacto y la lista exacta de lo añadido: un
   * vigésimo octavo `kind` que apareciera sin misión que lo justifique haría
   * fallar esto igual que lo haría borrar uno heredado.
   */
  it("y los cinco de step 23 van detrás, ni uno más: veintisiete en total", () => {
    const kinds = kindsDelFuente();
    expect(kinds.length).toBe(KINDS_HEREDADOS.length + KINDS_DE_M_VPS_23.length);
    expect(kinds.slice(KINDS_HEREDADOS.length)).toEqual(KINDS_DE_M_VPS_23);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("ningún evento de step 18 se ha colado en ese catálogo (viven en su propio registro)", () => {
    const kinds = kindsDelFuente();
    for (const propio of [
      "NO_SHOW_RECORDED",
      "NO_SHOW_CORRECTED",
      "NO_SHOW_COMMAND_REPEATED",
      "DEMO_CLOCK_ADVANCED",
      "RESERVATION_GROUP_CREATED",
      "RESERVATION_GROUP_LINE_CREATED",
      "RESERVATION_GROUP_REPEATED",
    ]) {
      expect(kinds, propio).not.toContain(propio);
    }
  });
});
