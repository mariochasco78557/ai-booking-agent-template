import { describe, expect, it } from "vitest";

import {
  auditSpokenMessages,
  type AuditCategory,
  type AuditViolation,
  type TranscriptTurn,
} from "../../src/voice/elevenlabs/transcriptAudit.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * BLOQUE «AUDITORÍA DEL MESSAGE HABLADO» · EL FIXTURE ES UN INCIDENTE REAL.
 *
 * El turno 15 de conv_8201m0tgy0vefe6be92v9sw7ftq8 llevaba, pegada a la
 * frase correcta pre-tool, la traza de razonamiento interno del modelo — y
 * el sintetizador de voz la pronunció entera. El texto de abajo es VERBATIM
 * ese `message` (sin PII: nombres de cliente, teléfono o email no aparecen
 * en él). Sirve de ancla: si algún día deja de dar estas violaciones, es que
 * la auditoría se ha desafinado, no que el incidente haya dejado de importar.
 * ────────────────────────────────────────────────────────────────────────
 */

const LEAKED_TURN_15_MESSAGE =
  "Perfecto, dame un momento mientras gestiono la cita.\n" +
  "thought\n" +
  "The user confirmed the appointment. Now I need to call `booking_book` to register the booking.\n" +
  "I have all the necessary information:\n" +
  '- `booking_confirmed`: True (user said "Sí, confirmo.")\n' +
  '- `date_iso`: "2026-08-26"\n' +
  '- `professional_id`: "any"\n' +
  "- `service_confirmed`: True (...)\n" +
  "- `service_id`: 1 (...)\n" +
  '- `time`: "12:30"\n' +
  "\n" +
  "According to rule 21, I need to say a short phrase before calling `booking_book`.";

function categoriesOf(violations: readonly AuditViolation[]): AuditCategory[] {
  return violations.map((v) => v.category);
}

describe("auditSpokenMessages · el fixture del incidente real dispara todas las categorías esperadas", () => {
  it("turno 15 verbatim, SIN turno siguiente de tool_call: ya dispara la mayoría de categorías", () => {
    const turns: TranscriptTurn[] = [{ role: "agent", message: LEAKED_TURN_15_MESSAGE }];
    const violations = auditSpokenMessages(turns);
    const categories = new Set(categoriesOf(violations));

    expect(categories.has("reasoningMarker")).toBe(true);
    expect(categories.has("operationalEnglish")).toBe(true);
    expect(categories.has("ruleReference")).toBe(true);
    expect(categories.has("toolName")).toBe(true);
    expect(categories.has("parameterName")).toBe(true);
    expect(categories.has("backtick")).toBe(true);
    // Sin turno siguiente de tool_call, la heurística pre-tool NO dispara todavía.
    expect(categories.has("textAfterPretoolPhrase")).toBe(false);
  });

  it("turno 15 verbatim, CON turno siguiente de tool_call: además dispara texto-tras-pretool", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: LEAKED_TURN_15_MESSAGE },
      { role: "agent", message: "", tool_calls: [{ tool_name: "booking_book" }] },
    ];
    const violations = auditSpokenMessages(turns);
    const forTurnZero = violations.filter((v) => v.turnIndex === 0);
    const categories = new Set(categoriesOf(forTurnZero));

    expect(categories.has("reasoningMarker")).toBe(true);
    expect(categories.has("operationalEnglish")).toBe(true);
    expect(categories.has("ruleReference")).toBe(true);
    expect(categories.has("toolName")).toBe(true);
    expect(categories.has("parameterName")).toBe(true);
    expect(categories.has("backtick")).toBe(true);
    expect(categories.has("textAfterPretoolPhrase")).toBe(true);

    const pretool = forTurnZero.find((v) => v.category === "textAfterPretoolPhrase");
    expect(pretool?.excerpt).toContain("thought");
  });

  it("acepta el envoltorio { transcript: [...] } de GET /v1/convai/conversations/{id}", () => {
    const violations = auditSpokenMessages({
      transcript: [{ role: "agent", message: LEAKED_TURN_15_MESSAGE }],
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  it("acepta el envoltorio { simulated_conversation: [...] } de POST simulate-conversation", () => {
    const violations = auditSpokenMessages({
      simulated_conversation: [{ role: "agent", message: LEAKED_TURN_15_MESSAGE }],
    });
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("auditSpokenMessages · mensajes limpios reales del flujo bueno dan CERO violaciones", () => {
  it("frase de espera pre-tool sin fuga: 'compruebo' no dispara 'prueba'", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: "Claro, Pedro, dame un momento y compruebo los huecos." },
    ];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("recapitulación con hora hablada y confirmación: 'regla' no aparece, no hay JSON", () => {
    const turns: TranscriptTurn[] = [
      {
        role: "agent",
        message:
          "Entonces, Pedro: sería un corte de pelo con cualquier profesional disponible el miércoles " +
          "veintiséis de agosto a las doce y media. ¿Confirmas la cita?",
      },
    ];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("despedida", () => {
    const turns: TranscriptTurn[] = [{ role: "agent", message: "Gracias, Pedro. Que tengas un buen día. Hasta luego." }];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("la palabra castellana 'regla' SIN número no dispara referencia_a_regla", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: "Vamos a seguir la regla general de citar con margen." },
    ];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });
});

describe("auditSpokenMessages · casos límite", () => {
  it("message vacío no produce violaciones ni lanza", () => {
    const turns: TranscriptTurn[] = [{ role: "agent", message: "" }];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("message ausente (undefined) se trata igual que vacío", () => {
    const turns: TranscriptTurn[] = [{ role: "agent" }];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("message en blanco (sólo espacios) no produce violaciones", () => {
    const turns: TranscriptTurn[] = [{ role: "agent", message: "   \n  " }];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("los turnos de usuario se ignoran aunque lleven contenido sospechoso", () => {
    const turns: TranscriptTurn[] = [
      { role: "user", message: "¿Qué es `booking_book` y el campo booking_confirmed? { \"a\": 1 } thought null true" },
    ];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("'demora' no dispara palabra_demo: 'demo' no es una palabra suelta ahí dentro", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: "Vamos a evitar cualquier demora en la confirmación de la cita." },
    ];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("el token 'true' aislado SÍ dispara booleanToken", () => {
    const turns: TranscriptTurn[] = [{ role: "agent", message: "El panel marcaba true en ese momento." }];
    const violations = auditSpokenMessages(turns);
    expect(categoriesOf(violations)).toContain("booleanToken");
  });

  it("la palabra castellana 'verdadero' NO dispara booleanToken", () => {
    const turns: TranscriptTurn[] = [{ role: "agent", message: "El panel marcaba verdadero en ese momento." }];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────
 * BLOQUE «ALCANCE REDUCIDO» · EL TELÉFONO SÓLO CREA RESERVAS NUEVAS.
 *
 * Decisión de producto: el agente telefónico puede CREAR una cita y nada
 * más. Modificar y cancelar citas existentes están FUERA DE ALCANCE: se
 * explican con naturalidad y se derivan a la ayuda humana. Romperlo tiene
 * dos formas, y aquí se auditan por separado — prometer la mutación
 * («outOfScopeMutationPromise») y ofrecerla («outOfScopeMutationOffer»).
 *
 * Las dos frases marcadas abajo como FIXTURE REAL salieron de la misma
 * llamada telefónica de producción, en turnos de agente consecutivos, y son
 * casi la misma cadena de palabras. Una abre una puerta que el producto no
 * tiene; la otra repite lo que ha pedido el cliente justo antes de avisar al
 * equipo, que es exactamente lo que debe hacer. Si alguna vez las dos caen
 * del mismo lado, la auditoría ha dejado de servir para lo único que se
 * construyó: separarlas.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Verbatim de la llamada real. Es una OFERTA: se marca. */
const OFERTA_REAL_DE_PRODUCCION =
  "Vale, entendido. ¿Quieres cambiar la cita que ya tienes o prefieres hacer una nueva reserva?";

/** Verbatim de la misma llamada. Es un ECO declarativo + derivación: NO se marca. */
const ECO_REAL_DE_PRODUCCION =
  "Entendido, quieres cambiar la cita que ya tienes. " +
  "Para poder ayudarte con eso, aviso al equipo de la peluquería.";

function auditar(message: string): AuditViolation[] {
  return auditSpokenMessages([{ role: "agent", message }]);
}

describe("auditSpokenMessages · alcance reducido: PROMESA de una mutación fuera de alcance", () => {
  const PROMESAS: ReadonlyArray<readonly [string, string]> = [
    ["cambio en pretérito perfecto con clítico", "Ya te la he cambiado."],
    ["cancelación en pretérito perfecto con clítico", "Te la he cancelado."],
    ["cancelación como estado resultante", "Queda anulada."],
    ["cambio como estado resultante", "Ya está movida."],
    ["cambio con hora, en perfecto", "Ya te la he adelantado a las once."],
    ["cancelación con la cita nombrada detrás", "He cancelado tu cita."],
    ["cancelación en perífrasis de resultado", "Tu cita ha quedado cancelada."],
    ["cambio en pasiva", "Listo, la cita ha sido cambiada."],
    ["cancelación recién hecha", "Acabo de cancelártela."],
    ["cancelación en pasiva refleja", "Se ha cancelado la cita."],
    ["cambio atribuido a terceros", "Ya han cambiado tu cita."],
    ["compromiso en firme de cancelar", "Voy a cancelártela ahora mismo."],
    ["compromiso en firme de mover la cita existente", "Vamos a cambiar la cita que ya tienes."],
    ["sustitución dada por hecha", "Ya te la he sustituido por la de las once."],
  ];

  for (const [nombre, frase] of PROMESAS) {
    it(`marca ${nombre}: «${frase}»`, () => {
      expect(categoriesOf(auditar(frase))).toContain("outOfScopeMutationPromise");
    });
  }

  it("una promesa NO se cuenta además como oferta: las dos categorías están separadas", () => {
    expect(categoriesOf(auditar("Te la he cancelado."))).toEqual(["outOfScopeMutationPromise"]);
  });

  it("la negación de OTRA cláusula no absuelve la promesa: «Te la he cambiado, no te preocupes.»", () => {
    expect(categoriesOf(auditar("Te la he cambiado, no te preocupes."))).toContain(
      "outOfScopeMutationPromise",
    );
  });

  it("el fragmento delator viaja en el excerpt", () => {
    const promesa = auditar("Ya te la he cambiado.").find(
      (v) => v.category === "outOfScopeMutationPromise",
    );
    expect(promesa?.excerpt).toContain("te la he cambiado");
  });
});

describe("auditSpokenMessages · alcance reducido: OFERTA de una mutación fuera de alcance", () => {
  it("FIXTURE REAL de producción: «¿Quieres cambiar la cita que ya tienes o prefieres hacer una nueva reserva?»", () => {
    const violations = auditar(OFERTA_REAL_DE_PRODUCCION);
    expect(categoriesOf(violations)).toEqual(["outOfScopeMutationOffer"]);
    expect(violations[0]?.excerpt).toContain("cambiar la cita que ya tienes");
  });

  const OFERTAS: ReadonlyArray<readonly [string, string]> = [
    ["ofrecimiento en primera persona con clítico pegado", "Puedo cancelártela."],
    ["ofrecimiento en primera persona con clítico suelto", "Te la anulo si quieres."],
    ["ofrecimiento tras condicional, en otra cláusula", "Si quieres, te la cancelo."],
    ["ofrecimiento con la cita nombrada", "Puedo anular tu cita si lo prefieres."],
    ["ofrecimiento de moverla, con dativo", "Te la cambio para el viernes."],
    ["pregunta por cancelar la cita existente", "¿Quieres que cancele la cita que tienes?"],
    ["pregunta por cancelar, en infinitivo", "¿Quieres cancelar la cita?"],
    ["pregunta por cancelar, sólo con clítico", "¿Quieres cancelarla?"],
    ["pregunta por mover la cita existente", "¿Quieres que te cambie la cita que ya tienes?"],
    ["pregunta por mover, en primera del plural sobre una cita anterior", "¿Prefieres que cambiemos tu cita anterior?"],
    ["pregunta por sustituir la cita existente", "¿Quieres que sustituyamos la cita que ya tienes?"],
  ];

  for (const [nombre, frase] of OFERTAS) {
    it(`marca ${nombre}: «${frase}»`, () => {
      expect(categoriesOf(auditar(frase))).toContain("outOfScopeMutationOffer");
    });
  }

  it("un mensaje que ofrece Y promete da las dos categorías, una sola vez cada una", () => {
    const categorias = categoriesOf(
      auditar("Te la he cancelado. ¿Quieres que cancele la otra cita que tienes?"),
    );
    expect(categorias.filter((c) => c === "outOfScopeMutationPromise").length).toBe(1);
    expect(categorias.filter((c) => c === "outOfScopeMutationOffer").length).toBe(1);
  });

  it("la violación se atribuye al turno del agente que la pronuncia, no al primero", () => {
    const violations = auditSpokenMessages([
      { role: "agent", message: "Hola, soy la recepcionista de la peluquería. ¿En qué puedo ayudarte?" },
      { role: "user", message: "Quería mover la cita del jueves." },
      { role: "agent", message: OFERTA_REAL_DE_PRODUCCION },
    ]);
    expect(violations.map((v) => v.turnIndex)).toEqual([2]);
    expect(categoriesOf(violations)).toEqual(["outOfScopeMutationOffer"]);
  });
});

describe("auditSpokenMessages · alcance reducido: lo que NO se marca", () => {
  it("FIXTURE REAL de producción: el eco declarativo antes de avisar al equipo queda limpio", () => {
    expect(auditar(ECO_REAL_DE_PRODUCCION)).toEqual([]);
  });

  const LIMPIAS: ReadonlyArray<readonly [string, string]> = [
    // 1 · EXPLICAR que no puede.
    ["explica quién gestiona los cambios", "Los cambios y las cancelaciones los gestiona el equipo."],
    ["niega poder cancelar", "No puedo cancelar citas desde aquí."],
    ["niega poder cambiar una cita existente", "No puedo cambiar una cita que ya tienes desde aquí."],
    ["niega con adverbio absoluto", "Nunca te la puedo cancelar yo desde aquí."],
    ["niega la mutación ya hecha", "No he cambiado nada de tu cita."],
    ["niega con «nada» al frente", "Nada queda cancelado por mi parte."],
    ["declara el alcance", "Desde aquí solo puedo hacer reservas nuevas."],
    // 2 · DERIVAR al equipo.
    ["deriva sin nombrar la acción", "Eso lo tiene que gestionar el equipo."],
    ["deriva nombrando la acción, en declarativa", "Para cambiar una cita hay que hablar con el equipo."],
    [
      "deriva nombrando la cita existente, en declarativa",
      "Para cambiar la cita que ya tienes tendrías que hablar con el equipo.",
    ],
    [
      "ofrece el ESCALADO en interrogativa, no la mutación",
      "¿Quieres que avise al equipo para cambiar la cita que ya tienes?",
    ],
    ["frase de oferta de ayuda humana del guion", "Si quieres, puedo dejar aviso al equipo; lo vería una persona de la peluquería, aunque no puedo confirmarte desde aquí cuándo."],
    ["frase de resultado de ayuda humana del guion", "Queda el aviso al equipo; lo verá una persona de la peluquería, aunque no puedo confirmarte desde aquí cuándo."],
    // 4 · Datos de una reserva EN CURSO, todavía sin confirmar.
    ["propone cambiar la hora de la reserva en curso", "¿Quieres que cambiemos la hora?"],
    ["acepta el cambio de hora antes de confirmar", "Vale, cambiamos a las 13:00."],
    ["propone cambiar el profesional de la reserva en curso", "¿Prefieres cambiar el profesional?"],
    ["cambia un dato en primera persona sin dativo", "Vale, lo cambio a las once."],
    ["da por cambiada la HORA de la reserva en curso", "Ya está cambiada la hora."],
    ["da por cambiado el PROFESIONAL de la reserva en curso", "Ya está cambiado el profesional."],
    ["propone cambiar el servicio, no la cita", "¿Quieres que te cambie el servicio a corte y barba?"],
    ["propone sustituir un dato de la reserva en curso", "¿Quieres que lo sustituyamos por corte y barba?"],
    ["cuenta que ha cambiado el profesional disponible", "El profesional ha cambiado, ahora sería con Dani."],
    [
      "avisa al equipo para que sean ELLOS quienes cancelen",
      "Aviso al equipo para que puedan cancelar la cita que ya tienes.",
    ],
    // Éxito de una reserva NUEVA: participio de registro, no de mutación.
    ["anuncia la cita registrada", "Perfecto, Pedro. La cita ha quedado registrada para el jueves a las diez con Nerea. ¿Necesitas alguna cosa más?"],
  ];

  for (const [nombre, frase] of LIMPIAS) {
    it(`no marca cuando ${nombre}: «${frase}»`, () => {
      expect(auditar(frase)).toEqual([]);
    });
  }

  it("la petición la hace el CLIENTE: los turnos de usuario siguen ignorándose", () => {
    const violations = auditSpokenMessages([
      { role: "user", message: "¿Puedes cancelármela? Quiero cambiar la cita que ya tengo. Te la anulo yo si quieres." },
    ]);
    expect(violations).toEqual([]);
  });

  it("el fixture del incidente de fuga NO gana categorías de alcance por el camino", () => {
    const categorias = new Set(categoriesOf(auditSpokenMessages([{ role: "agent", message: LEAKED_TURN_15_MESSAGE }])));
    expect(categorias.has("outOfScopeMutationPromise")).toBe(false);
    expect(categorias.has("outOfScopeMutationOffer")).toBe(false);
  });
});

describe("auditSpokenMessages · la heurística pre-tool necesita un tool_call en el turno siguiente", () => {
  it("frase de espera seguida de un turno SIN tool_call no dispara textAfterPretoolPhrase", () => {
    const turns: TranscriptTurn[] = [
      {
        role: "agent",
        message:
          "Un momento, lo compruebo enseguida. Estas son las opciones disponibles para el miércoles a las diez y a las once.",
      },
      { role: "agent", message: "¿Te viene mejor alguna de las dos?" },
    ];
    const violations = auditSpokenMessages(turns);
    expect(categoriesOf(violations)).not.toContain("textAfterPretoolPhrase");
  });

  it("frase de espera seguida de un turno de usuario tampoco dispara la heurística", () => {
    const turns: TranscriptTurn[] = [
      {
        role: "agent",
        message:
          "Un momento, lo gestiono ahora mismo. Estas son las opciones disponibles para el miércoles a las diez y a las once.",
      },
      { role: "user", message: "Vale, gracias." },
    ];
    const violations = auditSpokenMessages(turns);
    expect(categoriesOf(violations)).not.toContain("textAfterPretoolPhrase");
  });

  it("frase de espera seguida de tool_call SÍ dispara textAfterPretoolPhrase cuando sobra texto", () => {
    const turns: TranscriptTurn[] = [
      {
        role: "agent",
        message:
          "Un momento, lo registro ahora mismo. Esto es texto de más de veinte caracteres que no debería sonar aquí.",
      },
      { role: "agent", message: "", tool_calls: [{ tool_name: "booking_book" }] },
    ];
    const violations = auditSpokenMessages(turns);
    expect(categoriesOf(violations)).toContain("textAfterPretoolPhrase");
  });

  it("frase de espera seguida de tool_call, pero SIN texto de sobra, no dispara la heurística", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: "Un momento, lo compruebo enseguida." },
      { role: "agent", message: "", tool_calls: [{ tool_name: "booking_availability" }] },
    ];
    const violations = auditSpokenMessages(turns);
    expect(categoriesOf(violations)).not.toContain("textAfterPretoolPhrase");
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────
 * BLOQUE «AVISO AL EQUIPO SIN RESPALDO» · LA MENTIRA QUE NO SE VE EN EL TEXTO.
 *
 * Incidente real: en seis simulaciones remotas seguidas, `booking_human_help`
 * devolvió HTTP 400 y el agente dijo igualmente «Queda el aviso al equipo; lo
 * verá una persona de la peluquería, aunque no puedo confirmarte desde aquí
 * cuándo». El cliente colgó creyendo que alguien le iba a llamar. Nadie tenía
 * constancia de nada.
 *
 * Lo que hace especial a este bloque: la frase MENTIROSA y la frase VERDADERA
 * son la MISMA cadena de caracteres. Lo único que las separa está fuera del
 * texto — en si existe o no un `tool_result` de `booking_human_help` sin error
 * hasta ese turno. Por eso los dos fixtures de abajo son verbatim: el
 * `result_value` del 400 observado, y el cuerpo 200 real del puente (con su
 * `ok:false`, que es lo normal al escalar y NO significa que el aviso fallara).
 * Si algún día los dos caen del mismo lado, esta categoría ha dejado de servir.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Verbatim de las seis simulaciones del 400. Mentira o verdad según el respaldo. */
const FRASE_AVISO_HECHO =
  "Queda el aviso al equipo; lo verá una persona de la peluquería, aunque no puedo confirmarte desde aquí cuándo.";

/** La OFERTA del guion: casi las mismas palabras, pero no afirma nada. */
const FRASE_AVISO_OFRECIDO =
  "Si quieres, puedo dejar aviso al equipo; lo vería una persona de la peluquería, aunque no puedo confirmarte desde aquí cuándo.";

/** Verbatim del fallo observado en las seis simulaciones remotas. */
const RESULTADO_HELP_400 = {
  tool_name: "booking_human_help",
  is_error: true,
  result_value: "Error code: 400. Details: HTTP 400",
};

/**
 * Respuesta 200 real del puente al escalar, verificada hoy. Ojo al `ok:false`:
 * significa «no lo he resuelto yo, lo escalo», no que el aviso haya fallado.
 */
const RESULTADO_HELP_OK = {
  tool_name: "booking_human_help",
  is_error: false,
  result_value: JSON.stringify({
    ok: false,
    message:
      "He registrado tu solicitud de ayuda humana para que una persona del equipo lo revise. " +
      "No puedo confirmar un plazo de respuesta.",
    reason_code: "CUSTOMER_REQUESTS_HUMAN",
    help_requested: true,
    transfer_completed: false,
  }),
};

/** Resultado sin error pero que niega el aviso: el cuerpo manda sobre `is_error`. */
const RESULTADO_HELP_SIN_AVISO = {
  tool_name: "booking_human_help",
  is_error: false,
  result_value: JSON.stringify({ ok: false, help_requested: false, transfer_completed: false }),
};

/** Un resultado de OTRA herramienta: existe, no es error, y no respalda ningún aviso. */
const RESULTADO_AVAILABILITY_OK = {
  tool_name: "booking_availability",
  is_error: false,
  result_value: JSON.stringify({ ok: true, slots: ["10:00", "11:00"] }),
};

/** Audita una frase de agente en un transcript que SÍ trae resultados de tool. */
function auditarConResultados(message: string, results: readonly unknown[]): AuditViolation[] {
  return auditSpokenMessages([
    { role: "user", message: "Necesito hablar con alguien de la peluquería." },
    { role: "agent", message: "", tool_calls: [{ tool_name: "booking_human_help" }], tool_results: results },
    { role: "agent", message },
  ]);
}

describe("auditSpokenMessages · aviso al equipo dado por hecho sin respaldo", () => {
  it("FIXTURE REAL del 400: «Queda el aviso al equipo…» tras un tool_result con error SE MARCA", () => {
    const violations = auditarConResultados(FRASE_AVISO_HECHO, [RESULTADO_HELP_400]);
    expect(categoriesOf(violations)).toEqual(["unsupportedHumanHelpClaim"]);
    expect(violations[0]?.turnIndex).toBe(2);
    expect(violations[0]?.excerpt).toContain("Queda el aviso al equipo");
  });

  it("FIXTURE REAL del 200: la MISMA frase tras el resultado bueno del puente NO se marca", () => {
    expect(auditarConResultados(FRASE_AVISO_HECHO, [RESULTADO_HELP_OK])).toEqual([]);
  });

  it("el `ok:false` del cuerpo bueno no se confunde con un fallo: sigue respaldando", () => {
    const cuerpo = JSON.parse(RESULTADO_HELP_OK.result_value) as Record<string, unknown>;
    expect(cuerpo.ok).toBe(false);
    expect(cuerpo.help_requested).toBe(true);
    expect(auditarConResultados("Ya he avisado al equipo.", [RESULTADO_HELP_OK])).toEqual([]);
  });

  it("`help_requested:false` desmiente el aviso aunque `is_error` sea false: SE MARCA", () => {
    const violations = auditarConResultados("Ya he avisado al equipo.", [RESULTADO_HELP_SIN_AVISO]);
    expect(categoriesOf(violations)).toEqual(["unsupportedHumanHelpClaim"]);
  });

  it("la OFERTA de dejar aviso, sin ningún resultado que la respalde, NO se marca", () => {
    expect(auditarConResultados(FRASE_AVISO_OFRECIDO, [RESULTADO_HELP_400])).toEqual([]);
  });

  it("el reconocimiento honesto del fallo tras el 400 NO se marca", () => {
    expect(
      auditarConResultados("No he podido dejar el aviso al equipo desde aquí.", [RESULTADO_HELP_400]),
    ).toEqual([]);
  });

  it("la frase previa en el MISMO turno que invoca la herramienta NO se marca", () => {
    const turns: TranscriptTurn[] = [
      {
        role: "agent",
        message: "Dejo constancia para el equipo.",
        tool_calls: [{ tool_name: "booking_human_help" }],
        tool_results: [RESULTADO_HELP_400],
      },
    ];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("ni siquiera en perfecto se marca el turno que invoca la herramienta: el resultado aún no existe", () => {
    const turns: TranscriptTurn[] = [
      {
        role: "agent",
        message: "Queda el aviso al equipo.",
        tool_calls: [{ tool_name: "booking_human_help" }],
        tool_results: [RESULTADO_HELP_400],
      },
    ];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  const AFIRMACIONES: ReadonlyArray<readonly [string, string]> = [
    ["perfecto con destinatario", "Ya he avisado al equipo."],
    ["perfecto con el aviso nombrado", "He dejado constancia para el equipo."],
    ["perfecto con dativo y clítico", "Se lo he pasado al equipo."],
    ["perfecto sobre la solicitud", "He registrado tu solicitud de ayuda humana."],
    ["estado resultante en cabeza", "Queda constancia de lo que me cuentas."],
    ["estado resultante con atributo", "El aviso ya está hecho."],
    ["estado resultante en perífrasis", "Tu solicitud ha quedado registrada."],
    ["estado resultante con el aviso detrás", "Ha quedado registrado el aviso al equipo."],
    ["estado resultante sobre el equipo", "Ya está avisado el equipo."],
  ];

  for (const [nombre, frase] of AFIRMACIONES) {
    it(`marca la afirmación en ${nombre}: «${frase}»`, () => {
      expect(categoriesOf(auditarConResultados(frase, [RESULTADO_HELP_400]))).toContain(
        "unsupportedHumanHelpClaim",
      );
    });
  }

  const NO_AFIRMACIONES: ReadonlyArray<readonly [string, string]> = [
    // Oferta y condicional: nada ha pasado todavía.
    ["ofrece dejar el aviso", "Si quieres, puedo dejar aviso al equipo."],
    ["pregunta si dejar constancia", "¿Quieres que deje constancia de esto?"],
    ["ofrece en condicional", "Podría dejar constancia para que lo vean mañana."],
    // Futuro y presente pre-tool: la frase que acompaña a la llamada.
    ["anuncia en futuro perifrástico", "Voy a dejar constancia de esto."],
    ["anuncia en futuro simple", "Dejaré constancia para el equipo."],
    ["anuncia en presente", "Ahora aviso al equipo."],
    ["anuncia en presente con el aviso nombrado", "Dejo constancia para el equipo."],
    // Reconocimiento honesto del fallo: la negación NO puede quedar absorbida.
    ["niega haber podido", "No he podido dejar el aviso."],
    ["niega que el sistema le deje", "No me deja dejar el aviso ahora mismo."],
    ["niega el registro, con el aviso detrás", "No ha quedado registrado el aviso."],
    ["niega el registro, con el aviso delante", "El aviso no ha quedado registrado."],
    ["niega haber avisado", "No he avisado al equipo."],
    ["niega que quede constancia", "No queda constancia de tu petición."],
    ["niega con adverbio absoluto", "Todavía no queda constancia de nada."],
    ["niega con sujeto negativo", "Nadie ha dejado constancia todavía."],
    ["se disculpa y deriva", "No he podido dejar el aviso, así que te recomiendo llamar a la peluquería."],
    // Vecinos legítimos que hablan de la RESERVA, no del aviso.
    ["anuncia la reserva registrada", "He registrado tu cita para el jueves."],
    ["avisa de un dato de la reserva", "Te he avisado de que el hueco es a las diez."],
    ["cuenta que la cita quedó registrada", "La cita ha quedado registrada para el jueves a las diez con Nerea."],
  ];

  for (const [nombre, frase] of NO_AFIRMACIONES) {
    it(`no marca cuando ${nombre}: «${frase}»`, () => {
      expect(auditarConResultados(frase, [RESULTADO_HELP_400])).toEqual([]);
    });
  }

  it("la negación de OTRA cláusula no absuelve la afirmación: «No puedo dejar constancia ahora mismo, pero el aviso está hecho.»", () => {
    const violations = auditarConResultados(
      "No puedo dejar constancia ahora mismo, pero el aviso está hecho.",
      [RESULTADO_HELP_400],
    );
    expect(categoriesOf(violations)).toEqual(["unsupportedHumanHelpClaim"]);
    expect(violations[0]?.excerpt).toContain("el aviso está hecho");
  });

  it("la categoría convive con las de alcance sin taparlas ni duplicarse", () => {
    const violations = auditarConResultados("Queda anulada la cita y he avisado al equipo.", [
      RESULTADO_HELP_400,
    ]);
    expect(categoriesOf(violations)).toEqual([
      "outOfScopeMutationPromise",
      "unsupportedHumanHelpClaim",
    ]);
  });
});

describe("auditSpokenMessages · aviso al equipo: qué cuenta como respaldo y hasta dónde llega", () => {
  it("un resultado bueno en el MISMO turno que la afirmación ya respalda", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: FRASE_AVISO_HECHO, tool_results: [RESULTADO_HELP_OK] },
    ];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("un resultado con error en el MISMO turno que la afirmación no respalda: SE MARCA", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: FRASE_AVISO_HECHO, tool_results: [RESULTADO_HELP_400] },
    ];
    expect(categoriesOf(auditSpokenMessages(turns))).toEqual(["unsupportedHumanHelpClaim"]);
  });

  it("un resultado bueno POSTERIOR no respalda una afirmación anterior", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: FRASE_AVISO_HECHO, tool_results: [RESULTADO_HELP_400] },
      { role: "agent", message: "Un momento.", tool_results: [RESULTADO_HELP_OK] },
    ];
    const violations = auditSpokenMessages(turns);
    expect(categoriesOf(violations)).toEqual(["unsupportedHumanHelpClaim"]);
    expect(violations[0]?.turnIndex).toBe(0);
  });

  it("reintento: falla, se reconoce, se reintenta y la afirmación posterior queda limpia", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: "", tool_calls: [{ tool_name: "booking_human_help" }], tool_results: [RESULTADO_HELP_400] },
      { role: "agent", message: "No he podido dejar el aviso, lo intento otra vez." },
      { role: "agent", message: "", tool_calls: [{ tool_name: "booking_human_help" }], tool_results: [RESULTADO_HELP_OK] },
      { role: "agent", message: FRASE_AVISO_HECHO },
    ];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("dos afirmaciones sin respaldo se marcan una vez por turno, cada una en el suyo", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: "", tool_results: [RESULTADO_HELP_400] },
      { role: "agent", message: "Queda el aviso al equipo. Ya he avisado al equipo, de verdad." },
      { role: "agent", message: "El aviso está hecho." },
    ];
    const violations = auditSpokenMessages(turns);
    expect(categoriesOf(violations)).toEqual(["unsupportedHumanHelpClaim", "unsupportedHumanHelpClaim"]);
    expect(violations.map((v) => v.turnIndex)).toEqual([1, 2]);
  });

  it("el resultado de OTRA herramienta no respalda el aviso: SE MARCA", () => {
    const violations = auditarConResultados(FRASE_AVISO_HECHO, [RESULTADO_AVAILABILITY_OK]);
    expect(categoriesOf(violations)).toEqual(["unsupportedHumanHelpClaim"]);
  });

  it("`is_error` ausente cuenta como «sin error»: respalda", () => {
    const violations = auditarConResultados(FRASE_AVISO_HECHO, [
      { tool_name: "booking_human_help", result_value: '{"help_requested": true}' },
    ]);
    expect(violations).toEqual([]);
  });

  it("un `result_value` que no es JSON, sin error, respalda: no se inventa un fallo", () => {
    const violations = auditarConResultados(FRASE_AVISO_HECHO, [
      { tool_name: "booking_human_help", is_error: false, result_value: "Aviso registrado correctamente" },
    ]);
    expect(violations).toEqual([]);
  });

  it("un `result_value` vacío, sin error, respalda igual", () => {
    const violations = auditarConResultados(FRASE_AVISO_HECHO, [
      { tool_name: "booking_human_help", is_error: false, result_value: "" },
    ]);
    expect(violations).toEqual([]);
  });

  it("elementos basura en tool_results no rompen nada y no respaldan: SE MARCA", () => {
    const violations = auditarConResultados(FRASE_AVISO_HECHO, [
      null,
      "booking_human_help",
      42,
      ["booking_human_help"],
      { tool_name: "booking_human_help", is_error: "true", result_value: "boom" },
    ]);
    expect(categoriesOf(violations)).toEqual(["unsupportedHumanHelpClaim"]);
  });

  it("basta con que UNO de los resultados del turno respalde", () => {
    const violations = auditarConResultados(FRASE_AVISO_HECHO, [
      RESULTADO_AVAILABILITY_OK,
      RESULTADO_HELP_400,
      RESULTADO_HELP_OK,
    ]);
    expect(violations).toEqual([]);
  });
});

describe("auditSpokenMessages · aviso al equipo: sin datos de resultado, la regla no opina", () => {
  it("un transcript SIN `tool_results` en ningún turno no gana la categoría nueva", () => {
    expect(auditSpokenMessages([{ role: "agent", message: FRASE_AVISO_HECHO }])).toEqual([]);
  });

  it("`tool_results: null` no es dato: tampoco se opina", () => {
    const turns: TranscriptTurn[] = [{ role: "agent", message: FRASE_AVISO_HECHO, tool_results: null }];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("basta con que OTRO turno traiga la lista para que la regla vuelva a opinar", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: "", tool_results: [] },
      { role: "agent", message: FRASE_AVISO_HECHO, tool_results: null },
    ];
    expect(categoriesOf(auditSpokenMessages(turns))).toEqual(["unsupportedHumanHelpClaim"]);
  });

  it("una lista de resultados VACÍA sí es dato: no hay respaldo, se marca", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: "", tool_results: [] },
      { role: "agent", message: FRASE_AVISO_HECHO },
    ];
    expect(categoriesOf(auditSpokenMessages(turns))).toEqual(["unsupportedHumanHelpClaim"]);
  });

  it("los turnos de usuario siguen ignorándose aunque afirmen el aviso", () => {
    const turns: TranscriptTurn[] = [
      { role: "user", message: "Queda el aviso al equipo, ¿no? Ya he avisado al equipo yo.", tool_results: [] },
    ];
    expect(auditSpokenMessages(turns)).toEqual([]);
  });

  it("el fixture del incidente de fuga NO gana la categoría nueva por traer resultados", () => {
    const turns: TranscriptTurn[] = [
      { role: "agent", message: LEAKED_TURN_15_MESSAGE, tool_results: [RESULTADO_HELP_400] },
    ];
    const categorias = new Set(categoriesOf(auditSpokenMessages(turns)));
    expect(categorias.has("unsupportedHumanHelpClaim")).toBe(false);
  });

  it("el envoltorio de simulate-conversation también trae los resultados", () => {
    const violations = auditSpokenMessages({
      simulated_conversation: [
        { role: "agent", message: "", tool_results: [RESULTADO_HELP_400] },
        { role: "agent", message: FRASE_AVISO_HECHO },
      ],
    });
    expect(categoriesOf(violations)).toEqual(["unsupportedHumanHelpClaim"]);
  });
});
