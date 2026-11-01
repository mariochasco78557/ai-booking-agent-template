import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyWithdrawal,
  previewWithdrawal,
  withWithdrawalApplied,
  type CalendarWithdrawal,
} from "../../src/callEngine/calendar/withdrawal.js";
import { previewImpact, type ImpactResolution } from "../../src/callEngine/calendar/impact.js";
import { resolveDayWindows } from "../../src/callEngine/calendar/resolveAvailability.js";
import type {
  AuditStamp,
  EmployeeAbsence,
  OperationalCalendar,
  SyntheticReservation,
  VenueCalendarRule,
  VenueClosure,
  WeeklySchedule,
} from "../../src/callEngine/calendar/model.js";

/**
 * step 26 REAPERTURA §R13 — RETIRADA DE CIERRES, DÍAS ESPECIALES Y AUSENCIAS.
 *
 * Todo lo que hay aquí es sintético. Lo que estas pruebas fijan:
 *
 *  - Retirar es MARCAR `approval: "rejected"`, nunca borrar una fila, y nunca
 *    tocar `cal.reservations` (la regla dura de `applyChange`, heredada).
 *  - Retirar un `special_opening` PUEDE ROMPER UNA CITA, porque una apertura
 *    especial REEMPLAZA el horario del local: por eso la retirada pasa por la
 *    misma puerta de resoluciones que el alta, y no por una ruta más corta.
 *  - Un `id` duplicado se marca en TODAS sus filas (`.map`, no `.find`).
 *  - Retirar algo que no existe (o ya retirado) no es un impacto de cero: es
 *    un "no hay tal cosa", y el módulo lo dice devolviendo `undefined`.
 *  - Ningún fichero de `calendar/` importa `waitlist/` (J12, invariante I3).
 */

const EMP = 1;
const OTRO_EMP = 2;
const LUNES_ISO = "2026-08-03"; // lunes (dayOfWeek === 1), por comodidad
const RELOJ_DE_RETIRADA = "2026-08-12T10:15:00";

function audit(overrides: Partial<AuditStamp> = {}): AuditStamp {
  return { createdAt: "2026-01-01T00:00:00", createdBy: "fixture-sintetica", ...overrides };
}

function baseCalendar(overrides: Partial<OperationalCalendar> = {}): OperationalCalendar {
  return {
    professionals: [
      { employeeId: EMP, displayName: "Pro A (sintético)", synthetic: true },
      { employeeId: OTRO_EMP, displayName: "Pro B (sintético)", synthetic: true },
    ],
    weeklySchedules: [],
    closures: [],
    venueRules: [],
    absences: [],
    overrides: [],
    reservations: [],
    slotMinutes: 30,
    bookingHorizonDays: 90,
    minimumLeadMinutes: 0,
    ...overrides,
  };
}

/** Horario del LOCAL (no de nadie en concreto): 09:30–18:00 los lunes. */
function horarioDelLocal(): WeeklySchedule {
  return { ownerKind: "venue", dayOfWeek: 1, workDayStart: "09:30", workDayEnd: "18:00" };
}

/** La apertura especial de la trampa: el local abre de 10:00 a 22:00 ese día. */
function aperturaEspecial(overrides: Partial<VenueCalendarRule> = {}): VenueCalendarRule {
  return {
    id: "especial-nocturno",
    kind: "special_opening",
    scope: "venue",
    date: LUNES_ISO,
    closed: false,
    specialOpen: "10:00",
    specialClose: "22:00",
    source: "manual_override",
    approval: "approved",
    audit: audit(),
    ...overrides,
  };
}

function citaDeLasOcho(): SyntheticReservation {
  return {
    id: "res-20-00",
    employeeId: EMP,
    serviceId: 1,
    date: LUNES_ISO,
    startMinutes: 20 * 60,
    endMinutes: 20 * 60 + 30,
    status: "confirmed",
    synthetic: true,
  };
}

function retirada(overrides: Partial<CalendarWithdrawal> = {}): CalendarWithdrawal {
  return {
    kind: "venue_rule",
    id: "especial-nocturno",
    withdrawnAt: RELOJ_DE_RETIRADA,
    withdrawnBy: "console-operator",
    ...overrides,
  };
}

// =====================================================================
// P20 — LA TRAMPA DEL special_opening
// =====================================================================

describe("REAPERTURA §R13 · P20 — retirar un horario especial PUEDE romper una cita", () => {
  function calendarioDeLaTrampa(): OperationalCalendar {
    return baseCalendar({
      weeklySchedules: [horarioDelLocal()],
      venueRules: [aperturaEspecial()],
      reservations: [citaDeLasOcho()],
    });
  }

  it("la cita de las 20:00 CABE mientras la apertura especial está aprobada, y deja de caber sin ella", () => {
    const cal = calendarioDeLaTrampa();
    const sinLaCita: OperationalCalendar = { ...cal, reservations: [] };
    expect(resolveDayWindows(sinLaCita, EMP, LUNES_ISO).windows).toEqual([
      { startMinutes: 600, endMinutes: 1320 },
    ]);
    const retirado = withWithdrawalApplied(sinLaCita, retirada());
    expect(resolveDayWindows(retirado, EMP, LUNES_ISO).windows).toEqual([
      { startMinutes: 570, endMinutes: 1080 },
    ]);
  });

  it("previewWithdrawal REPORTA esa cita: la retirada no sólo libera horas, también las quita", () => {
    const cal = calendarioDeLaTrampa();
    const informe = previewWithdrawal(cal, retirada());
    expect(informe).toBeDefined();
    expect(informe?.impacted).toEqual([
      {
        reservationId: "res-20-00",
        employeeId: EMP,
        date: LUNES_ISO,
        startMinutes: 1200,
        endMinutes: 1230,
        serviceId: 1,
      },
    ]);
    expect([...(informe?.byEmployeeAndDate.keys() ?? [])]).toEqual([`${String(EMP)}|${LUNES_ISO}`]);
  });

  it("applyWithdrawal SIN resolución no aplica NADA: misma puerta que el alta", () => {
    const cal = calendarioDeLaTrampa();
    const resultado = applyWithdrawal(cal, retirada(), new Map<string, ImpactResolution>());
    expect(resultado.unresolved.map((r) => r.reservationId)).toEqual(["res-20-00"]);
    expect(resultado.flaggedForHumanContact).toEqual([]);
    expect(resultado.cal).toEqual(cal);
    expect(resultado.cal.venueRules[0]?.approval).toBe("approved");
  });

  it("applyWithdrawal CON resolución aplica la retirada y NO cancela, mueve ni toca ninguna reserva (P19)", () => {
    const cal = calendarioDeLaTrampa();
    const resoluciones = new Map<string, ImpactResolution>([["res-20-00", "mark_for_human_contact"]]);
    const resultado = applyWithdrawal(cal, retirada(), resoluciones);
    expect(resultado.unresolved).toEqual([]);
    expect(resultado.flaggedForHumanContact.map((r) => r.reservationId)).toEqual(["res-20-00"]);
    expect(resultado.cal.venueRules[0]?.approval).toBe("rejected");
    // La cita sigue exactamente donde estaba, con el mismo estado.
    expect(resultado.cal.reservations).toEqual(cal.reservations);
    expect(resultado.cal.reservations[0]?.status).toBe("confirmed");
    // Y el calendario de entrada no se ha mutado.
    expect(cal.venueRules[0]?.approval).toBe("approved");
  });
});

// =====================================================================
// P21 — MARCAR, NUNCA BORRAR; Y TODAS LAS FILAS DE UN id DUPLICADO
// =====================================================================

describe("REAPERTURA §R13 · P21 — la retirada marca `rejected` y conserva la fila", () => {
  it("un cierre retirado sigue en `closures`, con la misma información y `approval: rejected`", () => {
    const cierre: VenueClosure = {
      id: "cierre-reforma",
      kind: "full_closure",
      startDate: LUNES_ISO,
      endDate: LUNES_ISO,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cal = baseCalendar({ weeklySchedules: [horarioDelLocal()], closures: [cierre] });
    const despues = withWithdrawalApplied(cal, retirada({ kind: "venue_closure", id: "cierre-reforma" }));
    expect(despues.closures).toHaveLength(1);
    expect(despues.closures[0]).toMatchObject({
      id: "cierre-reforma",
      kind: "full_closure",
      startDate: LUNES_ISO,
      endDate: LUNES_ISO,
      approval: "rejected",
    });
  });

  it("un `id` DUPLICADO se marca en TODAS sus filas (.map, no .find)", () => {
    const primera: VenueClosure = {
      id: "cierre-repetido",
      kind: "full_closure",
      startDate: LUNES_ISO,
      endDate: LUNES_ISO,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const segunda: VenueClosure = { ...primera, startDate: "2026-08-10", endDate: "2026-08-10" };
    const otra: VenueClosure = { ...primera, id: "cierre-distinto" };
    const cal = baseCalendar({ closures: [primera, segunda, otra] });
    const despues = withWithdrawalApplied(cal, retirada({ kind: "venue_closure", id: "cierre-repetido" }));
    expect(despues.closures.map((c) => c.approval)).toEqual(["rejected", "rejected", "approved"]);
    expect(despues.closures).toHaveLength(3);
  });

  it("no toca reservations, weeklySchedules, seasonalSchedules, overrides ni professionals", () => {
    const cal = baseCalendar({
      weeklySchedules: [horarioDelLocal()],
      venueRules: [aperturaEspecial()],
      reservations: [citaDeLasOcho()],
      seasonalSchedules: [],
      overrides: [],
    });
    const despues = withWithdrawalApplied(cal, retirada());
    expect(despues.reservations).toBe(cal.reservations);
    expect(despues.weeklySchedules).toBe(cal.weeklySchedules);
    expect(despues.seasonalSchedules).toBe(cal.seasonalSchedules);
    expect(despues.overrides).toBe(cal.overrides);
    expect(despues.professionals).toBe(cal.professionals);
    expect(despues.closures).toBe(cal.closures);
    expect(despues.absences).toBe(cal.absences);
  });
});

// =====================================================================
// V1-1 — EL PREFILTRO TIENE QUE MIRAR TODAS LAS FILAS DEL id
//
// `withWithdrawalApplied` marca TODAS las filas aprobadas con ese `id`
// (`.map`), pero el prefiltro de `previewWithdrawal` se construía desde UNA
// sola fila. Con dos aperturas especiales aprobadas bajo el mismo `id` en
// fechas distintas, la retirada rompe las citas de LAS DOS fechas y el
// informe sólo contaba las de la primera: el operador resolvía una cita y se
// le llevaba por delante otra sin decírselo.
// =====================================================================

describe("REAPERTURA §R13 · V1-1 — el impacto se calcula sobre TODAS las filas aprobadas del id", () => {
  const OTRO_LUNES = "2026-08-10";

  function citaNocturna(id: string, date: string): SyntheticReservation {
    return { ...citaDeLasOcho(), id, date };
  }

  function calendarioConDosFilas(): OperationalCalendar {
    return baseCalendar({
      weeklySchedules: [horarioDelLocal()],
      venueRules: [aperturaEspecial(), aperturaEspecial({ date: OTRO_LUNES })],
      reservations: [citaNocturna("res-lunes-a", LUNES_ISO), citaNocturna("res-lunes-b", OTRO_LUNES)],
    });
  }

  it("dos filas aprobadas con el MISMO id, en fechas distintas: el informe reporta las citas de LAS DOS", () => {
    const cal = calendarioConDosFilas();
    const informe = previewWithdrawal(cal, retirada());
    expect(informe?.impacted.map((r) => r.reservationId)).toEqual(["res-lunes-a", "res-lunes-b"]);
  });

  it("y la puerta de resoluciones exige las DOS: no se aplica nada con una sola", () => {
    const cal = calendarioConDosFilas();
    const conUna = applyWithdrawal(cal, retirada(), new Map<string, ImpactResolution>([["res-lunes-a", "keep_and_flag"]]));
    expect(conUna?.unresolved.map((r) => r.reservationId)).toEqual(["res-lunes-b"]);
    expect(conUna?.cal.venueRules.map((r) => r.approval)).toEqual(["approved", "approved"]);

    const conLasDos = applyWithdrawal(
      cal,
      retirada(),
      new Map<string, ImpactResolution>([
        ["res-lunes-a", "keep_and_flag"],
        ["res-lunes-b", "keep_and_flag"],
      ]),
    );
    expect(conLasDos?.unresolved).toEqual([]);
    expect(conLasDos?.cal.venueRules.map((r) => r.approval)).toEqual(["rejected", "rejected"]);
    // Y ni una reserva se toca, como siempre.
    expect(conLasDos?.cal.reservations).toEqual(cal.reservations);
  });
});

// =====================================================================
// V1-2 / V1-3 — LA RETIRADA SÓLO TOCA LO QUE ESTÁ APROBADO
//
// Reutilizar un `id` es legal (la guarda del alta mira lo aprobado, no el
// historial). Marcar TODA fila con ese `id` significaba (a) reescribir el
// sello de una fila histórica ya retirada —el historial de enero pasaba a
// decir agosto, con la nota del acto nuevo— y (b) arrastrar a `rejected` una
// fila `pending_review` que nadie había mirado, sellada como revisada por
// `console-operator`. Una retirada retira lo que está puesto; lo que no lo
// está no es asunto suyo.
// =====================================================================

describe("REAPERTURA §R13 · V1-2/V1-3 — la retirada no reescribe el historial ajeno", () => {
  it("una fila YA RETIRADA con el mismo id conserva intacto su sello anterior", () => {
    const vieja = aperturaEspecial({
      approval: "rejected",
      audit: audit({ approvedAt: "2026-01-05T09:00:00", approvedBy: "console-operator", note: "retirado por error de tecleo" }),
    });
    const vigente = aperturaEspecial({ date: "2026-08-10" });
    const cal = baseCalendar({ weeklySchedules: [horarioDelLocal()], venueRules: [vieja, vigente] });

    const despues = withWithdrawalApplied(cal, retirada({ note: "obra en la calle" }));
    expect(despues.venueRules[0]).toEqual(vieja);
    expect(despues.venueRules[1]?.approval).toBe("rejected");
    expect(despues.venueRules[1]?.audit.approvedAt).toBe(RELOJ_DE_RETIRADA);
    expect(despues.venueRules[1]?.audit.note).toBe("obra en la calle");
  });

  it("una fila PENDIENTE DE REVISIÓN con el mismo id no se retira ni se sella: nadie la ha visto todavía", () => {
    const pendiente = aperturaEspecial({ approval: "pending_review", audit: audit({ createdBy: "holiday-provider" }) });
    const vigente = aperturaEspecial({ date: "2026-08-10" });
    const cal = baseCalendar({ weeklySchedules: [horarioDelLocal()], venueRules: [pendiente, vigente] });

    const despues = withWithdrawalApplied(cal, retirada());
    expect(despues.venueRules[0]).toEqual(pendiente);
    expect(despues.venueRules[0]?.approval).toBe("pending_review");
    expect(despues.venueRules[1]?.approval).toBe("rejected");
  });
});

// =====================================================================
// V1-7 — "NO HABÍA NADA QUE RETIRAR" NO SE PARECE A "NO IMPACTÓ A NADIE"
// =====================================================================

describe("REAPERTURA §R13 · V1-7 — applyWithdrawal distingue el 404 del éxito sin impacto", () => {
  it("sin fila aprobada con ese id devuelve `undefined`, no un resultado idéntico al de una retirada real", () => {
    const cal = baseCalendar({ weeklySchedules: [horarioDelLocal()], venueRules: [aperturaEspecial()] });
    expect(applyWithdrawal(cal, retirada({ id: "no-existe" }), new Map())).toBeUndefined();
    expect(applyWithdrawal(cal, retirada({ kind: "venue_closure" }), new Map())).toBeUndefined();
    const yaRetirado = withWithdrawalApplied(cal, retirada());
    expect(applyWithdrawal(yaRetirado, retirada(), new Map())).toBeUndefined();
  });

  it("una retirada REAL sin impacto devuelve un resultado, y se distingue por eso", () => {
    const cal = baseCalendar({ weeklySchedules: [horarioDelLocal()], venueRules: [aperturaEspecial()] });
    const resultado = applyWithdrawal(cal, retirada(), new Map());
    expect(resultado).toBeDefined();
    expect(resultado?.unresolved).toEqual([]);
    expect(resultado?.cal.venueRules[0]?.approval).toBe("rejected");
  });
});

// =====================================================================
// EL SELLO DE AUDITORÍA
// =====================================================================

describe("REAPERTURA §R13 — el sello de auditoría de la retirada", () => {
  it("conserva quién lo apuntó y cuándo, y sobrescribe quién lo retiró y cuándo", () => {
    const cal = baseCalendar({ venueRules: [aperturaEspecial({ audit: audit({ approvedAt: "2026-02-02T09:00:00", approvedBy: "quien-lo-apunto" }) })] });
    const despues = withWithdrawalApplied(cal, retirada({ withdrawnBy: "console-operator" }));
    expect(despues.venueRules[0]?.audit).toEqual({
      createdAt: "2026-01-01T00:00:00",
      createdBy: "fixture-sintetica",
      approvedAt: RELOJ_DE_RETIRADA,
      approvedBy: "console-operator",
    });
  });

  it("la nota operativa de la retirada se guarda en AuditStamp.note, recortada", () => {
    const cal = baseCalendar({ venueRules: [aperturaEspecial()] });
    const despues = withWithdrawalApplied(cal, retirada({ note: "  se anuló la reforma  " }));
    expect(despues.venueRules[0]?.audit.note).toBe("se anuló la reforma");
  });

  it("una nota vacía o en blanco no escribe `note`, y sin nota se conserva la que ya hubiera", () => {
    const conNotaPrevia = baseCalendar({ venueRules: [aperturaEspecial({ audit: audit({ note: "nota del alta" }) })] });
    expect(withWithdrawalApplied(conNotaPrevia, retirada()).venueRules[0]?.audit.note).toBe("nota del alta");
    expect(withWithdrawalApplied(conNotaPrevia, retirada({ note: "   " })).venueRules[0]?.audit.note).toBe(
      "nota del alta",
    );
    const sinNotaPrevia = baseCalendar({ venueRules: [aperturaEspecial()] });
    expect(withWithdrawalApplied(sinNotaPrevia, retirada()).venueRules[0]?.audit.note).toBeUndefined();
  });
});

// =====================================================================
// RETIRADAS QUE SÓLO ENSANCHAN — Y LAS QUE NO EXISTEN (P27)
// =====================================================================

describe("REAPERTURA §R13 — retirar un cierre o una ausencia casi nunca impacta, y se dice honestamente", () => {
  it("retirar un cierre de local que tapaba una cita no impacta a nadie: sólo ensancha", () => {
    const cierre: VenueClosure = {
      id: "cierre-reforma",
      kind: "full_closure",
      startDate: LUNES_ISO,
      endDate: LUNES_ISO,
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cita: SyntheticReservation = { ...citaDeLasOcho(), id: "res-11-00", startMinutes: 660, endMinutes: 690 };
    const cal = baseCalendar({ weeklySchedules: [horarioDelLocal()], closures: [cierre], reservations: [cita] });
    const informe = previewWithdrawal(cal, retirada({ kind: "venue_closure", id: "cierre-reforma" }));
    expect(informe?.impacted).toEqual([]);
    const resultado = applyWithdrawal(cal, retirada({ kind: "venue_closure", id: "cierre-reforma" }), new Map());
    expect(resultado.unresolved).toEqual([]);
    expect(resultado.cal.closures[0]?.approval).toBe("rejected");
    expect(resultado.cal.reservations).toEqual(cal.reservations);
  });

  it("retirar una ausencia de todo el día tampoco impacta: devuelve horas, no las quita", () => {
    const ausencia: EmployeeAbsence = {
      id: "ausencia-bea",
      employeeId: EMP,
      kind: "vacation",
      startDate: LUNES_ISO,
      endDate: LUNES_ISO,
      allDay: true,
      privateReason: "SECRETO-QUE-NUNCA-SALE",
      source: "manual_override",
      approval: "approved",
      audit: audit(),
    };
    const cita: SyntheticReservation = { ...citaDeLasOcho(), id: "res-11-30", startMinutes: 690, endMinutes: 720 };
    const cal = baseCalendar({ weeklySchedules: [horarioDelLocal()], absences: [ausencia], reservations: [cita] });
    const informe = previewWithdrawal(cal, retirada({ kind: "employee_absence", id: "ausencia-bea" }));
    expect(informe?.impacted).toEqual([]);
    // Y el informe NUNCA lleva el motivo privado ni la nota operativa.
    expect(JSON.stringify(informe)).not.toContain("SECRETO-QUE-NUNCA-SALE");
    expect(JSON.stringify(informe)).not.toContain("privateReason");
  });

  it("P27 — retirar algo que no existe, o ya retirado, NO es un impacto de cero: no hay tal cosa", () => {
    const cal = baseCalendar({ weeklySchedules: [horarioDelLocal()], venueRules: [aperturaEspecial()] });
    expect(previewWithdrawal(cal, retirada({ id: "no-existe" }))).toBeUndefined();
    // Tipo equivocado para un id que sí existe: tampoco hay tal cosa.
    expect(previewWithdrawal(cal, retirada({ kind: "venue_closure" }))).toBeUndefined();

    const yaRetirado = withWithdrawalApplied(cal, retirada());
    expect(previewWithdrawal(yaRetirado, retirada())).toBeUndefined();
    // Y aplicar sobre lo que no existe tampoco es una retirada de cero: es
    // `undefined`, para que no se confunda con un éxito sin impacto (V1-7).
    expect(applyWithdrawal(cal, retirada({ id: "no-existe" }), new Map())).toBeUndefined();
  });

  // La versión anterior de esta prueba repetía LA MISMA retirada —mismo
  // reloj, mismo actor, misma nota— sobre el resultado de la primera. Con el
  // reloj fijo no podía discriminar nada: quitar de `marcada` la guarda de
  // `approval !== "approved"` volvía a sellar la fila con los mismos valores
  // y el `toEqual` seguía pasando. La segunda retirada llega ahora con OTRO
  // reloj y OTRO actor, que es lo que pasa de verdad cuando alguien pulsa
  // «Retirar» sobre una pantalla sin refrescar: si la guarda cae, el sello de
  // la PRIMERA se reescribe y la prueba lo dice.
  it("una segunda retirada del mismo id, con otro reloj y otro actor, NO reescribe el sello de la primera", () => {
    const cal = baseCalendar({ weeklySchedules: [horarioDelLocal()], closures: [
      {
        id: "cierre-reforma",
        kind: "full_closure",
        startDate: LUNES_ISO,
        endDate: LUNES_ISO,
        source: "manual_override",
        approval: "approved",
        audit: audit(),
      },
    ] });
    const primera = retirada({ kind: "venue_closure", id: "cierre-reforma", note: "obra en la calle" });
    const unaVez = withWithdrawalApplied(cal, primera);
    expect(unaVez.closures[0]?.approval).toBe("rejected");
    expect(unaVez.closures[0]?.audit.approvedAt).toBe(RELOJ_DE_RETIRADA);

    const segunda = retirada({
      kind: "venue_closure",
      id: "cierre-reforma",
      withdrawnAt: "2026-09-30T18:45:00",
      withdrawnBy: "otro-operador",
      note: "vuelvo a darle sin querer",
    });
    const dosVeces = withWithdrawalApplied(unaVez, segunda);

    // Idempotente de verdad: la fila retirada conserva el sello de la PRIMERA.
    expect(dosVeces).toEqual(unaVez);
    expect(dosVeces.closures[0]?.audit.approvedAt).toBe(RELOJ_DE_RETIRADA);
    expect(dosVeces.closures[0]?.audit.approvedBy).toBe("console-operator");
    expect(dosVeces.closures[0]?.audit.note).toBe("obra en la calle");
    expect(dosVeces.closures[0]?.approval).toBe("rejected");
  });
});

// =====================================================================
// LA MISMA ARITMÉTICA QUE EL ALTA
// =====================================================================

describe("REAPERTURA §R13 — la retirada usa la MISMA cuenta que el alta", () => {
  it("dos operaciones distintas que dejan fuera la MISMA cita la describen exactamente igual", () => {
    const cal = baseCalendar({
      weeklySchedules: [horarioDelLocal()],
      venueRules: [aperturaEspecial()],
      reservations: [citaDeLasOcho()],
    });
    // (a) Retirar la apertura especial: el local vuelve a cerrar a las 18:00.
    const porLaRetirada = previewWithdrawal(cal, retirada())?.impacted;
    // (b) Dar de alta una ausencia de todo el día del mismo profesional: la
    //     misma cita se queda fuera, por otro camino del resolutor.
    const porElAlta = previewImpact(cal, {
      kind: "employee_absence",
      absence: {
        id: "ausencia-equivalente",
        employeeId: EMP,
        kind: "absence",
        startDate: LUNES_ISO,
        endDate: LUNES_ISO,
        allDay: true,
        source: "manual_override",
        approval: "approved",
        audit: audit(),
      },
    }).impacted;
    // Misma aritmética, mismo DTO, misma respuesta.
    expect(porLaRetirada).toEqual(porElAlta);
    expect(porLaRetirada).toHaveLength(1);
  });
});

// =====================================================================
// P31 — J12 / waitlist: ni una importación
// =====================================================================

describe("REAPERTURA §R13 · P31 — ningún módulo de calendar/ importa waitlist/", () => {
  it("withdrawal.ts no menciona waitlist por ninguna vía", () => {
    const fuente = readFileSync(join(process.cwd(), "src/callEngine/calendar/withdrawal.ts"), "utf8");
    expect(fuente).not.toContain("waitlist");
  });

  it("impact.ts tampoco, y sigue sin hacerlo", () => {
    const fuente = readFileSync(join(process.cwd(), "src/callEngine/calendar/impact.ts"), "utf8");
    expect(fuente.toLowerCase()).not.toContain("waitlist");
  });
});
