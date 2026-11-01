import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ────────────────────────────────────────────────────────────────────────
 * INVARIANTE DE ALCANCE DEL PROMPT DOCUMENTADO.
 *
 * `docs/elevenlabs-call-engine/AGENT_PROMPT_ES.md` no es prosa: dentro lleva,
 * literal, el prompt que hoy tiene aplicado el agente remoto de ElevenLabs.
 * Es la única copia versionada de lo que el modelo lee antes de hablar por
 * teléfono, así que es el único sitio donde una decisión de producto puede
 * quedar comprobada por una máquina en vez de por la memoria de alguien.
 *
 * La decisión que se comprueba aquí: el agente telefónico SOLO puede CREAR
 * reservas nuevas. Modificar y cancelar citas existentes están FUERA DE
 * ALCANCE — se explican con naturalidad y se derivan a la ayuda humana
 * (`booking_human_help`, que sólo deja constancia). Nace de una llamada real
 * de producción en la que el agente llegó a ofrecer «¿Quieres cambiar la
 * cita que ya tienes…?»: una puerta que el producto no tiene y que sólo
 * puede terminar en una promesa falsa o en una marcha atrás.
 *
 * Este fichero comprueba CONCEPTOS, no redacciones. Cada invariante acepta
 * varias formas de decir lo mismo, porque el prompt se reescribe a menudo y
 * un test pegado a una frase concreta sólo enseña a esquivarlo. Lo que no
 * acepta es que el concepto desaparezca: si alguien devuelve al prompt la
 * capacidad de mover o cancelar citas, o le quita la prohibición de
 * ofrecerlo, estos tests se ponen rojos.
 *
 * ESTADO ACTUAL (2026-08-25): el documento lleva ya el texto literal de la
 * v6 vigente en el agente remoto, con la v5 conservada más abajo como
 * histórico (el bloque cercado que este fichero extrae es el primero del
 * documento, el de la v6; el de la v5 no se comprueba aquí). Este fichero
 * verifica que la política de alcance reducido —consultar la agenda, crear
 * una reserva NUEVA y dejar aviso al equipo, y nada más— está presente en
 * ese prompt documentado, y que no se reintroduce la capacidad de modificar
 * o cancelar citas existentes.
 * ────────────────────────────────────────────────────────────────────────
 */

const RUTA_PROMPT = join(process.cwd(), "docs/elevenlabs-call-engine/AGENT_PROMPT_ES.md");

/** El bloque cercado que contiene el prompt literal, en cualquiera de las dos vallas. */
function extraerPromptLiteral(documento: string): string {
  const cercado = /(?:~~~|```)text\r?\n([\s\S]*?)\r?\n(?:~~~|```)/.exec(documento);
  if (cercado === null || cercado[1] === undefined) {
    throw new Error(
      "AGENT_PROMPT_ES.md ya no expone el prompt literal en un bloque cercado `text`: " +
        "sin ese bloque no hay invariante que comprobar.",
    );
  }
  return cercado[1];
}

/**
 * Minúsculas, sin tildes y con los saltos de línea convertidos en espacios.
 * El prompt va partido a mano en columnas estrechas: sin esta normalización,
 * cualquier concepto que cruce un salto de línea se escaparía por la forma,
 * no por el fondo.
 */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const PROMPT = normalizar(extraerPromptLiteral(readFileSync(RUTA_PROMPT, "utf8")));

/** Verbos de mutación de una cita, en infinitivo y en cualquier forma flexionada. */
const MUTAR = "(?:cambiar|modificar|mover|adelantar|retrasar|sustituir|cancelar|anular)";
const MUTAR_FLEX =
  "(?:cambi\\w*|modific\\w*|mover|muev\\w*|adelant\\w*|retras\\w*|sustitu\\w*|cancel\\w*|anul\\w*)";

/** Cualquiera de estas formas de decirlo vale: son el mismo concepto. */
function algunaCoincide(patrones: readonly RegExp[]): boolean {
  return patrones.some((p) => p.test(PROMPT));
}

describe("AGENT_PROMPT_ES.md · el fichero sigue exponiendo un prompt que se pueda auditar", () => {
  it("hay un bloque de prompt literal, con cuerpo suficiente y con las tres herramientas dentro", () => {
    expect(PROMPT.length).toBeGreaterThan(2000);
    expect(PROMPT).toContain("booking_availability");
    expect(PROMPT).toContain("booking_book");
    expect(PROMPT).toContain("booking_human_help");
  });
});

describe("AGENT_PROMPT_ES.md · política de alcance reducido: sólo se crean reservas nuevas", () => {
  it("declara en positivo que sólo crea reservas NUEVAS", () => {
    const declaraciones = [
      // «Solo puedes consultar la agenda, crear una reserva nueva y dejar aviso al equipo».
      new RegExp(
        `(?:solo|unicamente|solamente)[^.]{0,200}(?:crear|registrar|hacer|reservar)[^.]{0,80}` +
          `(?:citas? nuevas?|reservas? nuevas?|nuevas? citas?|nuevas? reservas?)`,
      ),
      // «Únicamente reservas citas nuevas; nada más».
      new RegExp(`(?:reservas?|citas?) nuevas?[^.]{0,120}(?:y (?:nada|ninguna otra)|nada mas)`),
      // «No puedes cambiar ni cancelar una cita: sólo crear una nueva».
      new RegExp(`no (?:puedes|podras|debes)[^.]{0,120}${MUTAR}[^.]{0,120}(?:nueva|nuevas)`),
    ];
    expect(
      algunaCoincide(declaraciones),
      "el prompt documentado no declara EN POSITIVO su alcance —consultar la agenda, crear una " +
        "reserva NUEVA y dejar aviso al equipo, y nada más—",
    ).toBe(true);
  });

  it("declara fuera de alcance cambiar, mover, sustituir o cancelar una cita existente", () => {
    const declaraciones = [
      // «Cambiar o cancelar una cita existente está fuera de su alcance».
      new RegExp(`${MUTAR}[^.]{0,160}fuera de (?:tu |su |mi |todo )?alcance`),
      new RegExp(`fuera de (?:tu |su |mi |todo )?alcance[^.]{0,160}${MUTAR_FLEX}`),
      // «No puedes cambiar ni cancelar una cita».
      new RegExp(`no (?:puedes|podras|debes)[^.]{0,120}${MUTAR}`),
      // «Está PROHIBIDO cambiar o cancelar una cita».
      new RegExp(`prohibido[^.]{0,120}${MUTAR}`),
      // «Cancelar o cambiar una cita no está automatizado» — la forma de la v5.
      new RegExp(`${MUTAR}[^.]{0,160}no esta automatizad`),
    ];
    expect(
      algunaCoincide(declaraciones),
      "el prompt no deja fuera de alcance cambiar, mover, sustituir o cancelar una cita existente",
    ).toBe(true);
  });

  it("nunca da la mutación por hecha: prohíbe afirmar que la cita queda cambiada o cancelada", () => {
    const prohibiciones = [
      new RegExp(
        `(?:nunca|no|prohibido|jamas)[^.]{0,160}` +
          `(?:cancelada|cambiada|anulada|movida|adelantada|retrasada|cancelado|cambiado|anulado|movido)`,
      ),
      new RegExp(`(?:nunca|no|prohibido|jamas)[^.]{0,120}(?:digas|decir|afirmes|afirmar|prometas|prometer)[^.]{0,120}${MUTAR_FLEX}`),
    ];
    expect(
      algunaCoincide(prohibiciones),
      "el prompt ya no prohíbe anunciar como hecha una cita cambiada o cancelada",
    ).toBe(true);
  });

  it("da la salida buena: cambios y cancelaciones se derivan a la ayuda humana", () => {
    expect(PROMPT).toContain("booking_human_help");
    // Las dos razones exactas del contrato de la herramienta, tal y como las
    // nombra la política: una para mover, otra para cancelar.
    expect(PROMPT).toContain("reschedule");
    expect(PROMPT).toContain("cancel");
    const derivaciones = [
      new RegExp(`${MUTAR_FLEX}[^.]{0,160}booking_human_help`),
      new RegExp(`booking_human_help[^.]{0,160}${MUTAR_FLEX}`),
      // El contrato de la herramienta nombra las dos razones exactas.
      /reschedule[^.]{0,120}(?:cambiar|mover)|(?:cambiar|mover)[^.]{0,120}reschedule/,
    ];
    expect(
      algunaCoincide(derivaciones),
      "el prompt no conecta cambiar o cancelar una cita con booking_human_help",
    ).toBe(true);
  });
});

describe("AGENT_PROMPT_ES.md · anti-regresión: nada devuelve al agente la capacidad de mutar", () => {
  /**
   * Cada patrón describe una manera concreta de reintroducir la capacidad
   * perdida. Ninguno puede aparecer: el día que uno case, el prompt estará
   * autorizando por escrito lo que el producto ha decidido no hacer.
   */
  /**
   * La regla 7 del prompt v6 nombra `booking_book` cerca de un verbo de
   * mutación DENTRO de una prohibición explícita: «Está PROHIBIDO […] usar
   * booking_book para intentarlo […] si quiere cambiar la que ya tiene». Esa
   * es exactamente la formulación real que declara fuera de alcance mutar
   * una cita — lo contrario de una regresión. Sin excluirla, el patrón de
   * abajo confundiría la prohibición con un permiso por la mera cercanía de
   * las palabras.
   *
   * La exclusión sólo debe absolver una prohibición LEGÍTIMA: un marcador de
   * negación («prohibido», «nunca», «jamás») que aparece antes de
   * `booking_book`, dentro de la misma frase, y que nadie ha negado a su vez.
   * Un `RegExp` con lookbehind negativo no distingue eso de una doble
   * negación («no está prohibido…», «ya no está prohibido…»), porque sólo
   * mira si la palabra "prohibido" está presente, no si a la propia palabra
   * la niega un "no" que la precede de cerca. Esa doble negación concede
   * justo lo contrario de lo que aparenta, así que aquí se decide con una
   * función legible en vez de una expresión regular más retorcida: se busca
   * el marcador más cercano hacia atrás, en la misma frase, y se comprueba
   * si un "no" lo niega inmediatamente antes.
   *
   * Comprobado por los dos tests explícitos de doble negación de abajo (el
   * punto ciego real, encontrado en revisión) y por el test que verifica que
   * el patrón sigue detectando el prompt inventado que sí concede la
   * capacidad sin ninguna prohibición de por medio.
   */
  function marcadorDeNegacionEstaNegado(contexto: string, indiceMarcador: number): boolean {
    const antes = contexto.slice(Math.max(0, indiceMarcador - 15), indiceMarcador);
    return /\bno\s+(?:esta\s+|era\s+|resulta\s+)?$/.test(antes);
  }

  /** ¿Hay, antes de `indice` y en la misma frase (máximo 200 caracteres), un
   * marcador de negación real —no negado a su vez— que la convierta en una
   * prohibición legítima? */
  function tieneProhibicionLegitimaAntes(texto: string, indice: number): boolean {
    const puntoAnterior = texto.lastIndexOf(".", indice - 1) + 1;
    const limiteInferior = Math.max(puntoAnterior, indice - 200);
    const contexto = texto.slice(limiteInferior, indice);
    const marcador = /(?:prohibido|nunca|jamas)/g;
    let encontrado: RegExpExecArray | null;
    while ((encontrado = marcador.exec(contexto)) !== null) {
      if (!marcadorDeNegacionEstaNegado(contexto, encontrado.index)) {
        return true;
      }
    }
    return false;
  }

  /** Todas las apariciones de `booking_book` cerca de un verbo de mutación,
   * salvo las que caen dentro de una prohibición legítima. Devuelve el
   * fragmento que prueba la regresión, o "" si no hay ninguna. */
  function demoSalonBookComoMutacion(texto: string): string {
    const mutacion = new RegExp(`booking_book[^.]{0,140}${MUTAR}`, "g");
    let coincidencia: RegExpExecArray | null;
    while ((coincidencia = mutacion.exec(texto)) !== null) {
      if (!tieneProhibicionLegitimaAntes(texto, coincidencia.index)) {
        return coincidencia[0];
      }
    }
    return "";
  }

  function coincidenciaDe(patron: RegExp): (texto: string) => string {
    return (texto) => {
      const encontrado = patron.exec(texto);
      return encontrado === null ? "" : encontrado[0];
    };
  }

  const REGRESIONES: ReadonlyArray<readonly [string, (texto: string) => string]> = [
    ["booking_book descrito como capaz de cambiar o cancelar", demoSalonBookComoMutacion],
    [
      "mutar una cita usando booking_book",
      coincidenciaDe(
        new RegExp(`${MUTAR}[^.]{0,140}(?:con|llamando a|usando|mediante|a traves de) booking_book`),
      ),
    ],
    [
      "instrucción de volver a reservar para mover una cita",
      coincidenciaDe(
        new RegExp(`(?:para|si quiere|cuando quiera) ${MUTAR}[^.]{0,140}(?:vuelve a reservar|reserva de nuevo|reserva otra vez|booking_book)`),
      ),
    ],
    [
      "permiso explícito de cancelar o cambiar",
      coincidenciaDe(
        new RegExp(`(?:puedes|podras|debes|tienes que) ${MUTAR} (?:una|la|su|esa|tu) (?:cita|reserva)`),
      ),
    ],
  ];

  for (const [nombre, coincide] of REGRESIONES) {
    it(`no aparece: ${nombre}`, () => {
      expect(coincide(PROMPT)).toBe("");
    });
  }

  it("los patrones de regresión saben fallar: sobre un prompt inventado que sí lo autoriza, saltan", () => {
    const PROMPT_MALO = normalizar(
      "booking_book registra la cita y también sirve para cambiar o cancelar una cita existente. " +
        "Si quiere cambiar la hora de una cita ya hecha, vuelve a reservar con booking_book. " +
        "Puedes cancelar una cita cuando la persona te lo pida.",
    );
    const mudos = REGRESIONES.filter(([, coincide]) => coincide(PROMPT_MALO) === "");
    expect(mudos.map(([nombre]) => nombre)).toEqual([]);
  });

  it("punto ciego corregido: doble negación 'no está prohibido usar booking_book para cambiar' sí se detecta", () => {
    const frase = normalizar(
      "No está prohibido usar booking_book para cambiar la cita que ya tiene.",
    );
    expect(demoSalonBookComoMutacion(frase)).not.toBe("");
  });

  it("punto ciego corregido: doble negación 'ya no está prohibido: booking_book ahora sirve también para cambiar' sí se detecta", () => {
    const frase = normalizar(
      "Ya no está prohibido: booking_book ahora sirve también para cambiar la cita.",
    );
    expect(demoSalonBookComoMutacion(frase)).not.toBe("");
  });
});
