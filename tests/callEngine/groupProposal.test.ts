import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { explainChoice } from "../../src/callEngine/allocation/anyProfessional.js";
import type { CalendarWithCapabilities } from "../../src/callEngine/capabilities.js";
import { isStartInThePast } from "../../src/callEngine/domain/slotTime.js";
import { fixedClock } from "../../src/callEngine/domain/types.js";
import { BOOKING_DEMO_NOW_MINUTES, BOOKING_DEMO_TODAY, demoSalonVenue } from "../../src/callEngine/fixtures/demoSalonVenue.js";
import { createGroup } from "../../src/callEngine/operations/groupCommands.js";
import { proposeGroup, type GroupProposalResult } from "../../src/callEngine/operations/groupProposal.js";
import {
  GROUP_MEMBER_LABEL_RE,
  groupIdFor,
  groupIntentKey,
  groupIntentKeyToMint,
  groupReservationIdFor,
  groupSlotKeyFor,
  type GroupLineRequest,
} from "../../src/callEngine/operations/model.js";
import { slotKeyFor } from "../../src/callEngine/waitlist/model.js";
import { IDEMPOTENCY_KEY_PATTERN } from "../../src/console/idempotency.js";

/**
 * step 18 · fase F — EL ALGORITMO DE PROPUESTA (diseño §4.5), con la
 * aritmética REAL del fixture verificada en §9.2 y §9.3.
 *
 * Martes 2026-08-04, temporada de agosto, 09:00–17:30 ⇒ 17 arranques (540 a
 * 1020 de 30 en 30). Álex = 3, Dani = 6, Nerea = 9. Nerea NO hace el servicio 0.
 * A las 09:00 los tres tienen libre el 540; Álex tiene 2 citas confirmadas hoy,
 * Dani 3 (la cancelada no cuenta) y Nerea 2.
 *
 * Cierra la parte de dominio de los criterios 8.19–8.23 y el 8.30.
 */

const ALEX = 3;
const DANI = 6;
const NEREA = 9;

function venue(): CalendarWithCapabilities {
  return demoSalonVenue();
}

function atNine() {
  return fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES);
}

function anyLine(memberLabel: string, serviceId: 0 | 1 | 2): GroupLineRequest {
  return { memberLabel, serviceId, professional: { kind: "any" } };
}

function withLine(memberLabel: string, serviceId: 0 | 1 | 2, employeeId: number): GroupLineRequest {
  return { memberLabel, serviceId, professional: { kind: "specific", employeeId } };
}

function propose(
  arrangement: "consecutive" | "simultaneous",
  lines: readonly GroupLineRequest[],
  options: { nowMinutes?: number; date?: string; cal?: CalendarWithCapabilities } = {},
): GroupProposalResult {
  const cal = options.cal ?? venue();
  const clock = fixedClock(BOOKING_DEMO_TODAY, options.nowMinutes ?? BOOKING_DEMO_NOW_MINUTES);
  return proposeGroup(cal, clock, { date: options.date ?? BOOKING_DEMO_TODAY, arrangement, lines });
}

// ---------------------------------------------------------------------
// §9.2 — dos consecutivas con servicios distintos
// ---------------------------------------------------------------------

describe("step 18 · §9.2 — dos personas consecutivas, cada una con SU servicio", () => {
  it("resuelve Álex 09:00 (corte) y Dani 09:30 (barba), y el desempate es el de chooseProfessional", () => {
    // La razón por la que la línea 1 es Álex, dicha con la función que decide:
    // los tres pueden y están libres, empatan a 14 huecos restantes, y Álex
    // tiene 2 citas confirmadas frente a las 3 de Dani; entre Álex y Nerea
    // (2 y 2) gana el id más bajo.
    const explanation = explainChoice(venue(), BOOKING_DEMO_TODAY, 540, 1);
    expect(explanation.candidates).toEqual([ALEX, DANI, NEREA]);
    expect(explanation.remainingSlotCounts).toEqual({ 3: 14, 6: 14, 9: 14 });
    expect(explanation.confirmedReservationCounts).toEqual({ 3: 2, 6: 3, 9: 2 });
    expect(explanation.chosen).toBe(ALEX);

    const result = propose("consecutive", [anyLine("Adulto A", 1), anyLine("Menor B", 0)]);
    expect(result.rejected).toBeUndefined();
    const first = result.proposals[0];
    expect(first?.lines).toEqual([
      {
        memberLabel: "Adulto A",
        serviceId: 1,
        employeeId: ALEX,
        date: BOOKING_DEMO_TODAY,
        startMinutes: 540,
        endMinutes: 570,
        slotKey: "slot-2026-08-04-540-3",
        professionalWasRequested: false,
      },
      {
        memberLabel: "Menor B",
        serviceId: 0,
        employeeId: DANI,
        date: BOOKING_DEMO_TODAY,
        startMinutes: 570,
        endMinutes: 600,
        slotKey: "slot-2026-08-04-570-6",
        professionalWasRequested: false,
      },
    ]);
  });

  it("la segunda línea es Dani porque Nerea NO puede y Álex ya está ocupado a las 09:30, no por casualidad", () => {
    const cal = venue();
    // Nerea no hace el servicio 0 en absoluto…
    const nereaBarba = explainChoice(cal, BOOKING_DEMO_TODAY, 570, 0);
    expect(nereaBarba.candidates).not.toContain(NEREA);
    // …y Álex tiene `demo-salon-res-1` a las 570, así que tampoco es candidato.
    expect(nereaBarba.candidates).toEqual([DANI]);
  });

  it("el servicio NO se copia de una línea a otra: cada una conserva el suyo", () => {
    const result = propose("consecutive", [anyLine("Adulto A", 1), anyLine("Menor B", 0)]);
    expect(result.proposals[0]?.lines.map((l) => l.serviceId)).toEqual([1, 0]);
  });

  it("devuelve como mucho tres propuestas, sin ninguna marcada ni recomendada", () => {
    const result = propose("consecutive", [anyLine("Adulto A", 1), anyLine("Menor B", 0)]);
    expect(result.proposals.length).toBe(3);
    // El tipo no tiene dónde guardar una preselección: no hay `recommended`,
    // `preferred` ni `highlighted` en ninguna propuesta.
    for (const proposal of result.proposals) {
      expect(Object.keys(proposal).sort()).toEqual(["arrangement", "date", "lines"]);
    }
    // Y salen en orden ascendente de arranque.
    const firstStarts = result.proposals.map((p) => p.lines[0]?.startMinutes);
    expect(firstStarts).toEqual([540, 570, 600]);
  });
});

// ---------------------------------------------------------------------
// §9.3 — dos a la vez, con profesionales distintos
// ---------------------------------------------------------------------

describe("step 18 · §9.3 — dos personas a la vez", () => {
  it("resuelve Álex y Nerea a las 09:00: los employeeId son distintos porque plegar la primera línea la sacó de isSlotFree", () => {
    const result = propose("simultaneous", [anyLine("Persona 1", 1), anyLine("Persona 2", 1)]);
    const first = result.proposals[0];
    expect(first?.lines.map((l) => [l.employeeId, l.startMinutes])).toEqual([
      [ALEX, 540],
      [NEREA, 540],
    ]);
    // Criterio 8.23: los profesionales de unas simultáneas son TODOS distintos.
    const ids = first?.lines.map((l) => l.employeeId) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("con tres personas a la vez salen los tres profesionales, uno por persona (plegado incremental)", () => {
    const result = propose("simultaneous", [anyLine("Persona 1", 1), anyLine("Persona 2", 1), anyLine("Persona 3", 1)]);
    const first = result.proposals[0];
    expect(first?.lines.map((l) => l.employeeId).sort((a, b) => a - b)).toEqual([ALEX, DANI, NEREA]);
    expect(first?.lines.every((l) => l.startMinutes === 540)).toBe(true);
  });

  it("las peticiones concretas se resuelven ANTES que las «cualquiera», así que el orden de tecleo no cambia el resultado", () => {
    const conNerea = propose("simultaneous", [anyLine("Persona 1", 1), withLine("Persona 2", 1, NEREA)]);
    const alReves = propose("simultaneous", [withLine("Persona 1", 1, NEREA), anyLine("Persona 2", 1)]);
    // En ambos casos la persona pedida se queda con su hueco y la
    // «cualquiera» va a Álex. Lo que cambia entre los dos es sólo qué
    // etiqueta lleva cada una, no quién atiende a quién.
    const quienAtiendeA = (result: GroupProposalResult): Record<string, number> =>
      Object.fromEntries((result.proposals[0]?.lines ?? []).map((l) => [l.memberLabel, l.employeeId]));
    expect(quienAtiendeA(conNerea)).toEqual({ "Persona 1": ALEX, "Persona 2": NEREA });
    expect(quienAtiendeA(alReves)).toEqual({ "Persona 1": NEREA, "Persona 2": ALEX });
    expect(conNerea.proposals[0]?.lines.every((l) => l.startMinutes === 540)).toBe(true);
    expect(alReves.proposals[0]?.lines.every((l) => l.startMinutes === 540)).toBe(true);
  });

  it("marca qué líneas pidieron a esa persona en concreto", () => {
    const result = propose("simultaneous", [withLine("Persona 1", 1, NEREA), anyLine("Persona 2", 1)]);
    const requested = result.proposals[0]?.lines.map((l) => [l.employeeId, l.professionalWasRequested]);
    expect(requested).toContainEqual([NEREA, true]);
    expect(requested).toContainEqual([ALEX, false]);
  });
});

// ---------------------------------------------------------------------
// §9.4 — lo imposible, explicado con verdad y ANTES de mirar el calendario
// ---------------------------------------------------------------------

describe("step 18 · §9.4 — rechazos del paso 0", () => {
  it("dos personas a la vez con el MISMO profesional concreto: imposible, y se dice por qué", () => {
    const result = propose("simultaneous", [withLine("Persona 1", 1, ALEX), withLine("Persona 2", 1, ALEX)]);
    expect(result.proposals).toEqual([]);
    expect(result.rejected).toEqual({
      conflict: "same_professional_twice_at_the_same_time",
      message:
        "Has pedido a Álex (sintético) para dos personas a la vez. " +
        "Una misma persona del equipo no puede atender dos citas en la misma media hora.",
    });
  });

  it("cuatro personas a la vez con tres profesionales: se dice el número real, no «no hay hueco»", () => {
    const result = propose("simultaneous", [
      anyLine("Persona 1", 1),
      anyLine("Persona 2", 1),
      anyLine("Persona 3", 1),
      anyLine("Persona 4", 1),
    ]);
    expect(result.proposals).toEqual([]);
    expect(result.rejected).toEqual({
      conflict: "simultaneous_needs_one_professional_per_person",
      message:
        "A la vez sólo caben tantas personas como profesionales hay: en esta demostración son 3. " +
        "Prueba con “una detrás de otra”.",
    });
  });

  it("pedir a Nerea para el servicio 0: se dice que no lo hace, no que no haya hueco", () => {
    const result = propose("consecutive", [withLine("Adulto A", 0, NEREA), anyLine("Menor B", 1)]);
    expect(result.rejected).toEqual({
      conflict: "professional_cannot_perform_service",
      message: "Nerea (sintética) no hace ese servicio. Elige a otra persona del equipo o cambia el servicio.",
    });
  });

  it("las mismas cuatro personas UNA DETRÁS DE OTRA sí caben: el rechazo era del arreglo, no del grupo", () => {
    const result = propose("consecutive", [
      anyLine("Persona 1", 1),
      anyLine("Persona 2", 1),
      anyLine("Persona 3", 1),
      anyLine("Persona 4", 1),
    ]);
    expect(result.rejected).toBeUndefined();
    expect(result.proposals[0]?.lines.map((l) => l.startMinutes)).toEqual([540, 570, 600, 630]);
  });

  it("un rechazo del paso 0 no llega a mirar el calendario: el calendario sale byte a byte igual", () => {
    const cal = venue();
    const before = JSON.stringify(cal.reservations);
    propose("simultaneous", [withLine("Persona 1", 1, ALEX), withLine("Persona 2", 1, ALEX)], { cal });
    expect(JSON.stringify(cal.reservations)).toBe(before);
  });
});

// ---------------------------------------------------------------------
// Tamaño del grupo y etiquetas cerradas (K8, K13)
// ---------------------------------------------------------------------

describe("step 18 · §4.3/§4.5 — de 2 a 4 personas, con etiquetas de una lista cerrada", () => {
  it("acepta 2, 3 y 4 personas", () => {
    for (const n of [2, 3, 4]) {
      const lines = ["Persona 1", "Persona 2", "Persona 3", "Persona 4"]
        .slice(0, n)
        .map((label) => anyLine(label, 1));
      expect(propose("consecutive", lines).rejected, `${String(n)} personas`).toBeUndefined();
    }
  });

  it("rechaza 1 y 5 personas", () => {
    expect(propose("consecutive", [anyLine("Persona 1", 1)]).rejected?.conflict).toBe("invalid_group_size");
    expect(
      propose("consecutive", [
        anyLine("Persona 1", 1),
        anyLine("Persona 2", 1),
        anyLine("Persona 3", 1),
        anyLine("Persona 4", 1),
        anyLine("Adulto A", 1),
      ]).rejected?.conflict,
    ).toBe("invalid_group_size");
  });

  it("la expresión de etiquetas es CERRADA: doce válidas y ni una más", () => {
    const valid = [
      "Persona 1",
      "Persona 2",
      "Persona 3",
      "Persona 4",
      "Adulto A",
      "Adulto B",
      "Adulto C",
      "Adulto D",
      "Menor A",
      "Menor B",
      "Menor C",
      "Menor D",
    ];
    for (const label of valid) expect(GROUP_MEMBER_LABEL_RE.test(label), label).toBe(true);
    for (const label of ["Persona 5", "Adulto E", "Menor", "Cliente A", "Marta", "Persona 1 ", "adulto a", ""]) {
      expect(GROUP_MEMBER_LABEL_RE.test(label), label).toBe(false);
    }
  });

  it("una etiqueta fuera de la lista, o repetida, no llega a proponer nada", () => {
    expect(propose("consecutive", [anyLine("Cliente A", 1), anyLine("Persona 2", 1)]).rejected?.conflict).toBe(
      "invalid_member_label",
    );
    expect(propose("consecutive", [anyLine("Persona 1", 1), anyLine("Persona 1", 0)]).rejected).toEqual({
      conflict: "duplicate_member_label",
      message: "Cada persona necesita una etiqueta distinta.",
    });
  });
});

// ---------------------------------------------------------------------
// El pasado y el horizonte, con las funciones que ya existían
// ---------------------------------------------------------------------

describe("step 18 · §4.5 paso 1 — el pasado y el horizonte", () => {
  it("con el reloj a las 12:00 ninguna propuesta empieza antes de las 12:00", () => {
    const result = propose("consecutive", [anyLine("Persona 1", 1), anyLine("Persona 2", 1)], { nowMinutes: 720 });
    expect(result.rejected).toBeUndefined();
    for (const proposal of result.proposals) {
      for (const line of proposal.lines) expect(line.startMinutes).toBeGreaterThanOrEqual(720);
    }
    expect(result.proposals[0]?.lines[0]?.startMinutes).toBe(720);
  });

  it("una fecha fuera del horizonte de reserva se dice como tal", () => {
    const result = propose("consecutive", [anyLine("Persona 1", 1), anyLine("Persona 2", 1)], { date: "2026-07-01" });
    expect(result.proposals).toEqual([]);
    expect(result.rejected?.conflict).toBe("date_outside_booking_horizon");
  });

  it("un día sin ningún hueco libre se dice como tal (lunes cerrado)", () => {
    const result = propose("consecutive", [anyLine("Persona 1", 1), anyLine("Persona 2", 1)], { date: "2026-08-10" });
    expect(result.proposals).toEqual([]);
    expect(result.rejected?.conflict).toBe("venue_closed_or_no_free_slot");
  });

  it("si queda UN hueco suelto pero el grupo no cabe, se dice eso y no «no hay hueco»", () => {
    // A las 17:00 sólo queda el arranque de las 17:00 (1020): la segunda línea
    // de unas consecutivas caería en las 17:30, que ya no existe.
    const result = propose("consecutive", [anyLine("Persona 1", 1), anyLine("Persona 2", 1)], { nowMinutes: 1020 });
    expect(result.proposals).toEqual([]);
    expect(result.rejected?.conflict).toBe("no_start_fits_the_whole_group");
    expect(result.rejected?.message).toContain("17:00");
  });
});

// ---------------------------------------------------------------------
// Pureza y determinismo
// ---------------------------------------------------------------------

describe("step 18 · §4.5 — puro y determinista", () => {
  it("tres ejecuciones con la misma entrada dan una salida idéntica byte a byte", () => {
    const runs = [0, 1, 2].map(() =>
      JSON.stringify(propose("consecutive", [anyLine("Adulto A", 1), anyLine("Menor B", 0)])),
    );
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it("proponer no toca el calendario que recibe (ni sus reservas)", () => {
    const cal = venue();
    const before = JSON.stringify(cal);
    propose("simultaneous", [anyLine("Persona 1", 1), anyLine("Persona 2", 1)], { cal });
    expect(JSON.stringify(cal)).toBe(before);
  });

  it("crear un grupo tampoco muta el calendario que recibe: devuelve la descripción de la escritura", () => {
    const cal = venue();
    const before = JSON.stringify(cal);
    const outcome = createGroup(
      { cal, clock: atNine(), groups: [], nextGroupNumber: 1 },
      {
        arrangement: "consecutive",
        date: BOOKING_DEMO_TODAY,
        lines: [
          { memberLabel: "Adulto A", serviceId: 1, employeeId: ALEX, startMinutes: 540 },
          { memberLabel: "Menor B", serviceId: 0, employeeId: DANI, startMinutes: 570 },
        ],
      },
    );
    expect(outcome.status).toBe(201);
    expect(JSON.stringify(cal)).toBe(before);
    expect(outcome.write?.nextCal?.reservations.length).toBe(cal.reservations.length + 2);
  });
});

// ---------------------------------------------------------------------
// Identidades: secuencia, clave de intención y formato del hueco
// ---------------------------------------------------------------------

describe("step 18 · §4.6 — las dos identidades", () => {
  it("el groupId sale de una secuencia y los ids de reserva lo llevan dentro", () => {
    expect(groupIdFor(1)).toBe("grp-0001");
    expect(groupIdFor(2)).toBe("grp-0002");
    expect(groupIdFor(10)).toBe("grp-0010");
    expect(groupReservationIdFor("grp-0001", 1)).toBe("res-g-grp-0001-1");
    expect(groupReservationIdFor("grp-0002", 4)).toBe("res-g-grp-0002-4");
  });

  it("la clave de intención es la de §9.2 y cabe en la cabecera Idempotency-Key", () => {
    const key = groupIntentKey(BOOKING_DEMO_TODAY, "consecutive", [
      { startMinutes: 540, employeeId: ALEX, serviceId: 1 },
      { startMinutes: 570, employeeId: DANI, serviceId: 0 },
    ]);
    expect(key).toBe("group:2026-08-04:consecutive:540-3-1.570-6-0");
    expect(groupIntentKeyToMint(key, 0)).toBe("group:2026-08-04:consecutive:540-3-1.570-6-0:r0");
    expect(IDEMPOTENCY_KEY_PATTERN.test(groupIntentKeyToMint(key, 0))).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test(groupIntentKeyToMint(key, 1))).toBe(true);
  });

  it("la clave no depende del orden en que lleguen las líneas: se ordena canónicamente", () => {
    const a = groupIntentKey(BOOKING_DEMO_TODAY, "simultaneous", [
      { startMinutes: 540, employeeId: NEREA, serviceId: 1 },
      { startMinutes: 540, employeeId: ALEX, serviceId: 1 },
    ]);
    const b = groupIntentKey(BOOKING_DEMO_TODAY, "simultaneous", [
      { startMinutes: 540, employeeId: ALEX, serviceId: 1 },
      { startMinutes: 540, employeeId: NEREA, serviceId: 1 },
    ]);
    expect(a).toBe("group:2026-08-04:simultaneous:540-3-1.540-9-1");
    expect(b).toBe(a);
  });

  it("la clave NO lleva etiquetas de persona: no viaja nada de nadie en la cabecera", () => {
    const key = groupIntentKey(BOOKING_DEMO_TODAY, "consecutive", [
      { startMinutes: 540, employeeId: ALEX, serviceId: 1 },
      { startMinutes: 570, employeeId: DANI, serviceId: 0 },
    ]);
    for (const label of ["Persona", "Adulto", "Menor", " "]) expect(key.includes(label)).toBe(false);
  });

  it("el formato de hueco de un grupo es EL MISMO que el de la lista de espera", () => {
    for (const [date, start, employee] of [
      [BOOKING_DEMO_TODAY, 540, ALEX],
      ["2026-08-06", 1020, NEREA],
    ] as const) {
      expect(groupSlotKeyFor(date, start, employee)).toBe(slotKeyFor(date, start, employee));
    }
  });
});

// ---------------------------------------------------------------------
// Criterio 8.30 — exactamente DOS cuerpos de la comprobación de hueco pasado
// ---------------------------------------------------------------------

const SRC_CALL_ENGINE_ROOT = join(process.cwd(), "src", "callEngine");

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("step 18 · criterio 8.30 — la comprobación de hueco pasado se escribe DOS veces, no tres", () => {
  it("sólo engine.ts y domain/slotTime.ts contienen la expresión", () => {
    // La expresión exacta: «este arranque es de HOY y cae antes de ahora más
    // la antelación mínima». `isWithinHorizon` también suma la antelación al
    // reloj, pero para otra pregunta (si el DÍA entero cabe), y por eso no
    // casa con la comparación estricta que se busca aquí.
    const bodies = listTsFiles(SRC_CALL_ENGINE_ROOT)
      .filter((file) =>
        /nowISODate\(\)[\s\S]{0,80}<\s*clock\.nowMinutes\(\)\s*\+/.test(codeOnly(readFileSync(file, "utf8"))),
      )
      .map((file) => relative(SRC_CALL_ENGINE_ROOT, file))
      .sort();
    expect(bodies).toEqual([join("domain", "slotTime.ts"), "engine.ts"]);
  });

  it("B6 de la lista de espera y la propuesta de grupo llaman al MISMO ayudante", () => {
    const matching = codeOnly(readFileSync(join(SRC_CALL_ENGINE_ROOT, "waitlist", "matching.ts"), "utf8"));
    const proposal = codeOnly(readFileSync(join(SRC_CALL_ENGINE_ROOT, "operations", "groupProposal.ts"), "utf8"));
    const commands = codeOnly(readFileSync(join(SRC_CALL_ENGINE_ROOT, "operations", "groupCommands.ts"), "utf8"));
    for (const [name, source] of [["matching", matching], ["groupProposal", proposal], ["groupCommands", commands]] as const) {
      expect(source.includes("isStartInThePast"), name).toBe(true);
      expect(source.includes("domain/slotTime.js"), name).toBe(true);
    }
  });

  it("el ayudante dice la verdad en la frontera: «ahora mismo» no es pasado, un minuto antes sí", () => {
    const clock = fixedClock(BOOKING_DEMO_TODAY, 720);
    expect(isStartInThePast(0, clock, BOOKING_DEMO_TODAY, 720)).toBe(false);
    expect(isStartInThePast(0, clock, BOOKING_DEMO_TODAY, 690)).toBe(true);
    expect(isStartInThePast(60, clock, BOOKING_DEMO_TODAY, 750)).toBe(true);
    expect(isStartInThePast(60, clock, BOOKING_DEMO_TODAY, 780)).toBe(false);
    // Un día FUTURO nunca es «pasado» para esta pregunta, ni a primera hora:
    // si cabe o no en el plazo lo decide isWithinHorizon.
    expect(isStartInThePast(0, clock, "2026-08-06", 540)).toBe(false);
    expect(isStartInThePast(60, clock, "2026-08-06", 0)).toBe(false);
    // ENMIENDA DE FASE K (H2): un día YA PASADO sí lo es, a cualquier hora y
    // con cualquier antelación mínima. Antes se contestaba `false` y el motivo
    // que llegaba al operador era el del horizonte, que no es el que necesita.
    expect(isStartInThePast(0, clock, "2026-08-03", 1439)).toBe(true);
    expect(isStartInThePast(0, clock, "2026-07-31", 540)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Frontera de módulos (la del bloque de waitlistMatching, vista desde aquí)
// ---------------------------------------------------------------------

describe("step 18 · §4.2 — operations/ no sabe nada de waitlist/", () => {
  it("ningún fichero de operations/ importa de waitlist/", () => {
    const inside = listTsFiles(SRC_CALL_ENGINE_ROOT).filter((f) =>
      relative(SRC_CALL_ENGINE_ROOT, f).startsWith(`operations${sep}`),
    );
    expect(inside.length).toBeGreaterThan(0);
    for (const file of inside) {
      expect(/from\s+["'][^"']*waitlist\//.test(codeOnly(readFileSync(file, "utf8"))), file).toBe(false);
    }
  });
});
