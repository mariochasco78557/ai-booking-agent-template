/**
 * ────────────────────────────────────────────────────────────────────────
 * AUDITORÍA DEL `message` HABLADO · FUGAS DE RAZONAMIENTO INTERNO AL TELÉFONO.
 *
 * Incidente de origen: en una llamada real (conv_8201m0tgy0vefe6be92v9sw7ftq8,
 * turno 15) el campo `message` de un turno de agente llevaba, PEGADA a la
 * frase correcta que sí debía sonar por TTS, la traza de razonamiento interno
 * del modelo — marcadores en inglés, el nombre de la herramienta, sus
 * parámetros y hasta backticks. Todo eso se pronunció al cliente. El agente
 * de ElevenLabs no distingue «lo que pienso» de «lo que digo»: si el modelo
 * lo escribe en `message`, el sintetizador de voz lo lee en voz alta. La
 * única defensa es auditar CADA `message` de agente antes de confiar en la
 * llamada, y este módulo es esa auditoría hecha función pura.
 *
 * Es un PUERTO de sólo lectura sobre datos ya en memoria: no abre sockets, no
 * lee ficheros, no importa nada fuera de la librería estándar de TypeScript.
 * Recibe la transcripción (ya parseada de JSON) y devuelve la lista de
 * violaciones — nunca lanza por contenido sospechoso, porque el uso previsto
 * es post-mortem y en tests, no bloquear una llamada en curso.
 *
 * Las categorías y los umbrales replican, turno a turno, el guion Python de
 * calibración usado en el bake-off de la misión 7 (`audit_transcript.py`):
 * mismas expresiones regulares, mismo léxico inglés inequívoco, misma
 * heurística de «texto tras frase pre-tool» y de «racha de inglés». Dos
 * diferencias deliberadas frente a ese guion, explicadas en el sitio:
 *
 *   1. Aquí sólo viven las comprobaciones sobre el CONTENIDO de cada
 *      `message` de agente (razonamiento, léxico, tools, parámetros, JSON,
 *      pre-tool, racha de inglés). El guion Python añade además
 *      `check_flow` (estructura tool_call → tool_result, recapitulación
 *      antes de reservar, anuncio de éxito respaldado) y `check_pii`
 *      (nombre/teléfono/email en los PARÁMETROS de la llamada a la tool).
 *      Son auditorías de otra naturaleza — miran la conversación entera o
 *      los argumentos de la tool, no lo que se pronuncia — y no las pide
 *      esta utilidad; se puede añadir un módulo hermano el día que hagan
 *      falta, sin tocar éste.
 *
 *   2. Las clases de carácter que delimitan un token aislado (`\w` en el
 *      guion Python) se amplían aquí con las vocales acentuadas y la eñe del
 *      castellano. En Python 3, `\w` sobre una cadena `str` ya es Unicode y
 *      cubre "á", "é", "ñ"…; el `\w` de una `RegExp` de JavaScript SIN el
 *      indicador `u` es puro ASCII. Sin este ajuste, un límite de palabra en
 *      castellano se calcularía distinto en cada lenguaje y el puerto
 *      dejaría de ser un calco fiel del guion calibrado.
 *
 * A esa auditoría de fugas se le ha sumado después una segunda familia, que
 * no viene del guion Python porque no existía cuando se calibró: el ALCANCE
 * del producto. El agente telefónico sólo puede CREAR reservas nuevas —
 * modificar y cancelar citas existentes están fuera de alcance—, y hay dos
 * maneras de romperlo hablando: prometer una mutación que nadie ha ejecutado
 * y ofrecerla. Las dos se auditan aquí, con la misma naturaleza de función
 * pura sobre el texto pronunciado, y están explicadas al detalle en el
 * bloque «Alcance reducido» de más abajo.
 *
 * Y una tercera familia, de un incidente posterior: el AVISO AL EQUIPO DADO
 * POR HECHO cuando la herramienta que lo registra ha fallado. Ésta es la
 * única regla del módulo que no se decide leyendo sólo el texto: necesita
 * mirar los RESULTADOS de las herramientas del propio transcript. Está
 * explicada al detalle en el bloque «Aviso al equipo sin respaldo».
 * ────────────────────────────────────────────────────────────────────────
 */

/** Rol de un turno tal y como lo nombra la API de ElevenLabs. */
export type TranscriptTurnRole = string;

/**
 * Un turno de transcripción, en el formato mínimo que necesita esta
 * auditoría. Encaja SIN adaptar con un turno de `GET .../conversations/{id}`
 * (`transcript[]`) y con uno de `POST simulate-conversation`
 * (`simulated_conversation[]`): las dos API de ElevenLabs hablan la misma
 * forma de turno (`role`, `message`, `tool_calls`, `tool_results`).
 *
 * `tool_results` es OPCIONAL, igual que `tool_calls`, y sus elementos son
 * `unknown` a propósito: la forma exacta la pone ElevenLabs y no queremos que
 * un campo nuevo suyo rompa la compilación de este puerto. Quien la necesite
 * la estrecha en tiempo de ejecución — ver {@link isSupportingHelpResult}.
 * Un transcript que no traiga `tool_results` en NINGÚN turno sigue siendo
 * entrada válida: simplemente no se puede auditar con él lo que dependa de
 * los resultados (ver el bloque «Aviso al equipo sin respaldo»).
 */
export interface TranscriptTurn {
  readonly role: TranscriptTurnRole;
  readonly message?: string | null;
  readonly tool_calls?: readonly unknown[] | null;
  readonly tool_results?: readonly unknown[] | null;
}

export type TranscriptTurns = readonly TranscriptTurn[];

/**
 * Lo que de verdad llega desde ElevenLabs: o ya es la lista de turnos, o es
 * el objeto que la envuelve bajo la clave del endpoint que la produjo. Pasar
 * la respuesta HTTP entera, tal cual, es tan válido como pasar la lista ya
 * extraída — la normalización vive aquí para que ningún llamador tenga que
 * saber de qué endpoint vino el JSON.
 */
export type TranscriptSource =
  | TranscriptTurns
  | { readonly transcript: TranscriptTurns }
  | { readonly simulated_conversation: TranscriptTurns };

/**
 * Las categorías que esta auditoría sabe reconocer. Las trece primeras son
 * FUGAS de razonamiento interno; las dos siguientes son incumplimientos del
 * ALCANCE del producto — ver el bloque «Alcance reducido» más abajo—; y la
 * última es el aviso al equipo dado por hecho sin que ninguna herramienta lo
 * respalde — ver el bloque «Aviso al equipo sin respaldo».
 */
export type AuditCategory =
  | "reasoningMarker"
  | "operationalEnglish"
  | "ruleReference"
  | "toolName"
  | "parameterName"
  | "jsonBraces"
  | "backtick"
  | "codeFence"
  | "jsonColon"
  | "nullToken"
  | "booleanToken"
  | "demoWord"
  | "textAfterPretoolPhrase"
  | "englishRun"
  | "outOfScopeMutationPromise"
  | "outOfScopeMutationOffer"
  | "unsupportedHumanHelpClaim";

/** Una fuga detectada: en qué turno, de qué categoría, y el trozo que la delata. */
export interface AuditViolation {
  readonly turnIndex: number;
  readonly category: AuditCategory;
  readonly excerpt: string;
}

// ---------------------------------------------------------------------
// Reglas sobre el contenido de cada `message` de agente.
// ---------------------------------------------------------------------

/** `\w` de Python + vocales acentuadas y eñe: ver nota (2) del docblock. */
const WORD_BOUNDARY = "\\wáéíóúüñÁÉÍÓÚÜÑ";

const RULES: ReadonlyArray<readonly [AuditCategory, RegExp]> = [
  [
    "reasoningMarker",
    new RegExp(`(?<![${WORD_BOUNDARY}])(thought|thoughts|analysis|reasoning|thinking)(?![${WORD_BOUNDARY}])`, "i"),
  ],
  ["operationalEnglish", /\b(I need|I will|I should|The user|According to|Now I|Let me|I have all)\b/i],
  ["ruleReference", /\b(rule|regla)\s+(n[uú]mero\s+)?\d+/i],
  ["ruleReference", /\breglas numeradas\b/i],
  [
    "toolName",
    new RegExp(
      `(?<![${WORD_BOUNDARY}])(booking_availability|booking_book|booking_human_help|end_call|tool_call|tool)(?![${WORD_BOUNDARY}])`,
      "i",
    ),
  ],
  [
    "parameterName",
    /(booking_confirmed|date_iso|professional_id|service_id|service_confirmed|time_iso|announces_success|system__)/i,
  ],
  ["jsonBraces", /[{}]/],
  ["backtick", /`/],
  ["codeFence", /```/],
  // «clave»: valor  o  ]: (estilo JSON). Un «Pedro: hola» normal NO dispara.
  ["jsonColon", /"[^"\n]{1,60}"\s*:|\]\s*:/],
  // tokens técnicos en minúscula exacta, aislados (no existen en castellano).
  ["nullToken", new RegExp(`(?<![${WORD_BOUNDARY}])null(?![${WORD_BOUNDARY}])`)],
  ["booleanToken", new RegExp(`(?<![${WORD_BOUNDARY}])(true|false)(?![${WORD_BOUNDARY}])`)],
  [
    "demoWord",
    /(?<![\wáéíóúüñ])(pruebas?|simulad[ao]s?|sint[ée]tic[ao]s?|demos?)(?![\wáéíóúüñ])/i,
  ],
];

// Frase pre-tool: marcador temporal + verbo de acción en la misma frase.
const PRETOOL_MARKER = /\b(un momento|ahora mismo|enseguida)\b/i;
const PRETOOL_VERB = /\b(compruebo|consulto|gestiono|registro)\b/i;
const SENTENCE_END = /[.?!…]/g;

// ---------------------------------------------------------------------
// ALCANCE REDUCIDO · EL TELÉFONO SÓLO CREA RESERVAS NUEVAS.
//
// Decisión de producto: el agente telefónico puede CREAR una cita y nada
// más. Modificar y cancelar citas existentes están FUERA DE ALCANCE; la vía
// correcta es explicarlo con naturalidad y ofrecer la ayuda humana
// (`booking_human_help`, que sólo deja constancia). Dos incumplimientos
// distintos, y por eso dos categorías separadas:
//
//   · `outOfScopeMutationPromise` — el agente afirma como HECHO CONSUMADO
//     que una cita ha quedado cambiada, movida, adelantada, retrasada,
//     sustituida, cancelada o anulada («ya te la he cambiado», «queda
//     anulada»); o la da
//     por descontada con un compromiso en firme, sin preguntar nada («voy a
//     cancelártela ahora mismo»). Es la más grave: promete al cliente una
//     mutación que nadie ha ejecutado ni va a poder ejecutar.
//   · `outOfScopeMutationOffer` — el agente OFRECE o PREGUNTA si quiere
//     cambiar o cancelar una cita que ya existe («¿quieres cambiar la cita
//     que ya tienes?», «puedo cancelártela»). Vino de una llamada real de
//     producción: la oferta abre una puerta que el producto no tiene, y
//     todo lo que venga detrás será o una promesa falsa o una marcha atrás.
//
// La dificultad NO está en encontrar los verbos, está en NO marcar los
// cuatro vecinos legítimos. Cada uno tiene aquí su defensa explícita:
//
//   1. EXPLICAR que no puede: «no puedo cancelar citas desde aquí». Defensa:
//      {@link NEGATOR} por CLÁUSULA, exigiendo que ninguna negación aparezca
//      antes del final del tramo casado. Y los patrones se escriben SIN
//      huecos elásticos entre las piezas (nada de `[^.]{0,30}`) justamente
//      para que una negación no pueda quedar ABSORBIDA dentro del tramo y
//      pasar desapercibida: ese falso positivo ya se pagó una vez.
//   2. DERIVAR al equipo: «los cambios los gestiona el equipo», «para
//      cambiar una cita hay que hablar con el equipo». Defensa:
//      {@link HANDOFF_GUARD}, que descarta la frase entera. Ofrecer
//      escalado nunca es ofrecer una mutación, ni siquiera en interrogativa
//      («¿quieres que avise al equipo para cambiar la cita que ya tienes?»).
//   3. Que lo pida el CLIENTE. Defensa: heredada — sólo se auditan los
//      turnos de rol `agent`.
//   4. Cambiar datos de una reserva EN CURSO, aún sin confirmar: «¿quieres
//      que cambiemos la hora?», «vale, cambiamos a las 13:00». Tres
//      defensas: (a) la 1.ª persona del PLURAL —el idioma con el que se
//      negocian los datos en curso— queda fuera del léxico; (b) los verbos
//      de mover exigen un sintagma de cita EXISTENTE
//      ({@link EXISTING_APPT}: «tu cita», «la cita que ya tienes», «la cita
//      anterior»), nunca un simple «la»; (c) {@link BOOKING_DATUM} descarta
//      la cláusula que habla de hora, día, fecha, servicio o profesional sin
//      nombrar ninguna cita.
//
// Y la oferta pide además marca de INTERROGACIÓN (o un ofrecimiento en 1.ª
// persona: «puedo…», «te la…»). Ése es el corte fino entre las dos frases
// reales que este módulo tiene que separar: «¿Quieres cambiar la cita que ya
// tienes o prefieres hacer una nueva reserva?» es oferta; «Entendido,
// quieres cambiar la cita que ya tienes.» es un eco declarativo del deseo
// del cliente, previo al aviso al equipo, y NO se marca.
// ---------------------------------------------------------------------

/** Clítico pegado al verbo: «‑te», «‑la», «‑tela»… Puede estar ausente. */
const CLITIC = "(?:(?:te|se|me|nos)?(?:l[ao]s?)?)";

/** Infinitivos de MOVER o SUSTITUIR una cita, con clítico pegado opcional. */
const MOVE_INF = `(?:(?:cambi|adelant|retras|desplaz)[aá]r|mov[eé]r|sustitu[ií]r)${CLITIC}`;

/**
 * Cualquier forma de MOVER, incluida la 1.ª del plural. Sólo se usa en las
 * reglas que EXIGEN detrás un sintagma de cita existente: con ese ancla,
 * «¿cambiamos tu cita?» es inequívoco y no se confunde con el «cambiamos»
 * de negociar los datos de la reserva en curso.
 */
const MOVE_VERB =
  `(?:${MOVE_INF}` +
  "|cambi[eo]|cambias|cambia|cambiamos|cambiemos" +
  "|muevo|mueves|mueve|mueva|movemos|movamos" +
  "|adelant[eo]|adelantamos|adelantemos" +
  "|retras[eo]|retrasamos|retrasemos" +
  "|desplac[eo]|desplazamos|desplacemos" +
  "|sustituyo|sustituyes|sustituye|sustituya|sustituimos|sustituyamos)";

/** Infinitivos de CANCELAR una cita, con clítico pegado opcional. */
const CANCEL_INF = `(?:cancel|anul)[aá]r${CLITIC}`;

/** Cancelar con clítico OBLIGATORIO: «cancelarla», «cancelártela», «anularlas». */
const CANCEL_INF_CLITIC = "(?:cancel|anul)[aá]r(?:te|se|me|nos)?l[ao]s?";

/** Subjuntivo/1.ª persona del plural de cancelar: «que te la cancele», «¿la anulamos?». */
const CANCEL_OTHER = "(?:cancele|anule|cancelamos|anulamos|cancelo|anulo)";

/** Participios de mutación. Son la marca del HECHO CONSUMADO. */
const MUT_PART = "(?:cambiad|movid|adelantad|retrasad|desplazad|sustituid|cancelad|anulad)[oa]s?";

/**
 * Presente de 1.ª persona del SINGULAR. El PLURAL («cambiamos», «movemos»,
 * «cancelamos») se deja fuera a propósito de las ofertas no interrogativas:
 * es el idioma con el que se negocian los datos de la reserva en curso
 * («vale, cambiamos a las 13:00»), no el de mutar una cita ya existente.
 */
const MUT_PRES1 = "(?:cambio|muevo|adelanto|retraso|sustituyo|cancelo|anulo)";

/**
 * Sintagma de cita con marca EXPLÍCITA de que YA EXISTE. Deliberadamente NO
 * incluye «la cita del jueves»: durante una reserva en curso ese sintagma
 * designa justo la cita que se está creando, así que no distingue nada.
 */
const EXISTING_APPT =
  "(?:" +
  "(?:l[ao]s?|tu|su|esa|esas|aquella|otra)\\s+(?:citas?|reservas?)\\s+que\\s+(?:ya\\s+)?(?:tienes|ten[íi]as|tiene|ten[ée]is)" +
  "|(?:tu|su|esa|esas|aquella)\\s+(?:citas?|reservas?)" +
  "|l[ao]s?\\s+(?:otra|anterior(?:es)?)\\s+(?:citas?|reservas?)" +
  "|l[ao]s?\\s+(?:citas?|reservas?)\\s+anterior(?:es)?" +
  "|l[ao]\\s+que\\s+ya\\s+tienes" +
  ")";

/**
 * Cualquier sintagma de cita. Vale para cancelar: cancelar presupone que la
 * cita existe. Admite hasta dos determinantes encadenados («la otra cita»).
 */
const ANY_APPT = "(?:(?:l[ao]s?|tu|su|esa|esas|aquella|una|otra)\\s+){0,2}(?:citas?|reservas?)";

/** Reglas de alcance. `onlyInQuestion` marca las que exigen frase interrogativa. */
interface ScopeRule {
  readonly category: AuditCategory;
  readonly pattern: RegExp;
  readonly onlyInQuestion: boolean;
}

/** Compila un patrón de alcance aislándolo por límites de palabra castellanos. */
function scopePattern(body: string): RegExp {
  return new RegExp(`(?<![${WORD_BOUNDARY}])(?:${body})(?![${WORD_BOUNDARY}])`, "i");
}

const SCOPE_RULES: readonly ScopeRule[] = [
  // ---- PROMESA de mutación ya ejecutada ----
  {
    // «ya te la he cambiado», «te la he cancelado», «las hemos anulado».
    category: "outOfScopeMutationPromise",
    pattern: scopePattern(`(?:ya\\s+)?(?:te\\s+|se\\s+|os\\s+)?l[ao]s?\\s+(?:he|hemos)\\s+${MUT_PART}`),
    onlyInQuestion: false,
  },
  {
    // «he cancelado tu cita», «ya hemos cambiado la reserva», «se ha cancelado la
    // cita», «ya han cambiado tu cita». Exigir la cita DETRÁS es lo que deja
    // fuera «la hora ha cambiado» y «el profesional ha cambiado».
    category: "outOfScopeMutationPromise",
    pattern: scopePattern(`(?:ya\\s+)?(?:se\\s+)?(?:he|hemos|ha|han)\\s+${MUT_PART}\\s+${ANY_APPT}`),
    onlyInQuestion: false,
  },
  {
    // «queda anulada», «ya está movida», «ha quedado cancelada», «ha sido cambiada».
    category: "outOfScopeMutationPromise",
    pattern: scopePattern(
      `(?:ya\\s+)?(?:queda|quedan|est[áa]|est[áa]n|(?:ha|han)\\s+(?:quedado|sido))\\s+${MUT_PART}`,
    ),
    onlyInQuestion: false,
  },
  {
    // «acabo de cancelártela», «acabamos de cambiar tu cita».
    category: "outOfScopeMutationPromise",
    pattern: scopePattern(
      `acab(?:o|amos)\\s+de\\s+(?:${CANCEL_INF_CLITIC}|(?:${CANCEL_INF}|${MOVE_INF})\\s+${ANY_APPT})`,
    ),
    onlyInQuestion: false,
  },
  {
    // Compromiso en firme, que es la otra cara de la misma moneda: «voy a
    // cancelártela ahora mismo», «vamos a cambiar la cita que ya tienes». No es
    // una oferta —no pregunta nada— sino una mutación dada por descontada.
    category: "outOfScopeMutationPromise",
    pattern: scopePattern(
      `(?:voy|vamos)\\s+a\\s+(?:${CANCEL_INF_CLITIC}|${CANCEL_INF}\\s+${ANY_APPT}|${MOVE_INF}\\s+${EXISTING_APPT})`,
    ),
    onlyInQuestion: false,
  },

  // ---- OFERTA de mutación fuera de alcance ----
  {
    // Ofrecimiento en 1.ª persona: «puedo cancelártela», «podría anular tu cita»,
    // «puedo cambiar la cita que ya tienes». Mover exige cita existente.
    category: "outOfScopeMutationOffer",
    pattern: scopePattern(
      `(?:puedo|podemos|podr[íi]a|podr[íi]amos)\\s+(?:${CANCEL_INF_CLITIC}|${CANCEL_INF}\\s+${ANY_APPT}|${MOVE_VERB}\\s+${EXISTING_APPT})`,
    ),
    onlyInQuestion: false,
  },
  {
    // Ofrecimiento en 1.ª persona con clítico: «te la anulo si quieres», «te la cancelo».
    category: "outOfScopeMutationOffer",
    pattern: scopePattern(`(?:te|os|se)\\s+l[ao]s?\\s+${MUT_PRES1}`),
    onlyInQuestion: false,
  },
  {
    // Interrogativa sobre MOVER una cita que ya existe:
    // «¿Quieres cambiar la cita que ya tienes…?», «¿te cambio tu cita?».
    category: "outOfScopeMutationOffer",
    pattern: scopePattern(`${MOVE_VERB}\\s+${EXISTING_APPT}`),
    onlyInQuestion: true,
  },
  {
    // Interrogativa sobre CANCELAR: «¿quieres cancelar la cita?», «¿te la cancelo?»,
    // «¿la anulamos?», «¿quieres que la cancele?», «¿quieres que cancele la cita
    // que tienes?».
    category: "outOfScopeMutationOffer",
    pattern: scopePattern(
      `(?:${CANCEL_INF_CLITIC}|${CANCEL_INF}\\s+${ANY_APPT}|(?:te\\s+)?l[ao]s?\\s+${CANCEL_OTHER}|${CANCEL_OTHER}\\s+${ANY_APPT})`,
    ),
    onlyInQuestion: true,
  },
];

/**
 * Negaciones. Se buscan por CLÁUSULA y sólo cuentan las que aparecen ANTES
 * del final del tramo casado: «no puedo cancelar citas desde aquí» se
 * descarta, pero «te la he cancelado, no te preocupes» sí se marca.
 */
const NEGATOR = new RegExp(
  `(?<![${WORD_BOUNDARY}])(?:no|nunca|jam[áa]s|tampoco|ning[úu]n|ninguna|nada|nadie)(?![${WORD_BOUNDARY}])`,
  "gi",
);

/** Derivación a una persona: ofrecer escalado nunca es ofrecer una mutación. */
const HANDOFF_GUARD = new RegExp(
  [
    "(?:dejar|dejarte|dejo|dejamos|deje|dej[ée]|dejar[ée])\\s+(?:un\\s+|el\\s+)?aviso",
    "avis(?:o|ar|arte|e|amos|ar[ée])\\s+al\\s+equipo",
    "queda\\s+el\\s+aviso",
    "(?:hablar|hablarlo|habla|hablas|hable|hablo)\\s+(?:directamente\\s+)?con\\s+(?:el\\s+equipo|la\\s+peluquer[íi]a|el\\s+sal[óo]n|una\\s+persona)",
    "(?:gestiona|gestionan|gestionar|gestionarlo|lleva|llevan|ve|ver[áa]|ven|mira|miran)\\s+(?:directamente\\s+)?(?:el\\s+equipo|la\\s+peluquer[íi]a|el\\s+sal[óo]n|una\\s+persona)",
    "el\\s+equipo\\s+de\\s+la\\s+peluquer[íi]a",
    "una\\s+persona\\s+(?:de\\s+la\\s+peluquer[íi]a|del\\s+sal[óo]n|del\\s+equipo)",
    "no\\s+est[áa]\\s+automatizad",
  ].join("|"),
  "i",
);

/** Datos de la reserva EN CURSO: hablar de ellos no es mutar una cita existente. */
const BOOKING_DATUM = new RegExp(
  `(?<![${WORD_BOUNDARY}])(?:hora|horas|d[íi]a|d[íi]as|fecha|fechas|servicio|servicios|profesional|profesionales)(?![${WORD_BOUNDARY}])`,
  "i",
);

/** Cualquier mención a una cita, en cualquier forma. */
const APPOINTMENT_NOUN = new RegExp(
  `(?<![${WORD_BOUNDARY}])(?:citas?|reservas?)(?![${WORD_BOUNDARY}])`,
  "i",
);

/** Separadores de cláusula: la negación de una cláusula no alcanza a la otra. */
const CLAUSE_SEPARATOR = /[,;:]|\s+(?:pero|aunque|porque|as[íi] que|sin embargo)\s+/g;

/**
 * Léxico inglés inequívoco (sin homógrafos castellanos: fuera «a», «no»,
 * «me», «he», «use», «la», «con», «once», «come», «media», «sea», «son»…).
 * Copiado tal cual del guion de calibración Python.
 */
const ENGLISH_LEXICON: ReadonlySet<string> = new Set([
  "the", "to", "need", "call", "user", "confirmed", "appointment", "now",
  "have", "all", "necessary", "information", "said", "clearly", "stated",
  "i", "will", "should", "would", "could", "must", "register", "booking",
  "book", "because", "according", "rule", "first", "next", "then", "that",
  "this", "with", "from", "they", "which", "what", "when", "is", "are",
  "was", "were", "be", "been", "being", "and", "of", "for", "it", "its",
  "not", "but", "by", "on", "at", "as", "an", "or", "if", "so", "my", "we",
  "you", "your", "their", "there", "can", "cannot", "do", "does", "did",
  "done", "make", "makes", "say", "says", "tell", "told", "ask", "asked",
  "want", "wants", "get", "got", "going", "just", "also", "only", "time",
  "date", "service", "professional", "any", "true", "false", "yes",
  "confirm", "confirmation", "check", "checked", "available",
  "availability", "slot", "slots", "let", "us", "him", "her", "them",
  "think", "thinking", "thought", "know", "known", "see", "seen", "look",
  "looking", "during", "while", "since", "until", "again", "more", "most",
  "some", "such", "own", "same", "other", "than", "too", "very", "before",
  "after",
]);

const WORD_TOKEN = /[a-záéíóúüñA-ZÁÉÍÓÚÜÑ_]+/g;

// ---------------------------------------------------------------------
// Utilidades puras
// ---------------------------------------------------------------------

/** El trozo de `text` alrededor de `[start, end)`, con puntos suspensivos si se recorta. */
function excerpt(text: string, start: number, end: number, radius = 45): string {
  const a = Math.max(0, start - radius);
  const b = Math.min(text.length, end + radius);
  const chunk = text.slice(a, b).replace(/\n/g, "\\n");
  return `${a > 0 ? "…" : ""}${chunk}${b < text.length ? "…" : ""}`;
}

/** `[[inicio, fin_incluyendo_puntuación], …]` por frase de `text`. */
function sentencesWithOffsets(text: string): ReadonlyArray<readonly [number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    out.push([start, end]);
    start = end;
  }
  if (start < text.length) out.push([start, text.length]);
  return out;
}

interface EnglishRun {
  readonly start: number;
  readonly end: number;
  readonly wordCount: number;
}

/** La primera racha de MÁS de 6 palabras inglesas consecutivas, si existe. */
function englishRunViolation(text: string): EnglishRun | null {
  const tokens: Array<{ word: string; start: number; end: number }> = [];
  for (const match of text.matchAll(WORD_TOKEN)) {
    const start = match.index ?? 0;
    tokens.push({ word: match[0].toLowerCase(), start, end: start + match[0].length });
  }
  // Centinela final para cerrar una racha que llegara hasta el final del texto.
  tokens.push({ word: " ", start: text.length, end: text.length });

  let run: Array<{ word: string; start: number; end: number }> = [];
  for (const token of tokens) {
    if (ENGLISH_LEXICON.has(token.word)) {
      run.push(token);
      continue;
    }
    if (run.length > 6) {
      const first = run[0];
      const last = run[run.length - 1];
      if (first !== undefined && last !== undefined) {
        return { start: first.start, end: last.end, wordCount: run.length };
      }
    }
    run = [];
  }
  return null;
}

/**
 * `[[inicio, fin], …]` por cláusula de `text`, en coordenadas ABSOLUTAS del
 * mensaje (de ahí `base`). Trocear por comas y por las conjunciones que
 * cambian de sujeto es lo que impide que la negación de «no puedo cambiarla»
 * se confunda con la promesa de «te la he cambiado, no te preocupes».
 */
function clausesWithOffsets(text: string, base: number): ReadonlyArray<readonly [number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (const match of text.matchAll(CLAUSE_SEPARATOR)) {
    const idx = match.index ?? 0;
    out.push([base + start, base + idx]);
    start = idx + match[0].length;
  }
  out.push([base + start, base + text.length]);
  return out;
}

/** ¿Hay una negación en `clause` antes de la posición `end`? */
function negatedBefore(clause: string, end: number): boolean {
  for (const match of clause.matchAll(NEGATOR)) {
    if ((match.index ?? 0) < end) return true;
  }
  return false;
}

/**
 * Incumplimientos del ALCANCE en un `message` de agente: promesa u oferta de
 * mutar una cita existente. Devuelve como mucho UNA violación por categoría,
 * la primera, igual que hacen las reglas de contenido. Ver el bloque
 * «Alcance reducido» para el porqué de cada defensa contra falsos positivos.
 */
function outOfScopeViolations(msg: string): ReadonlyArray<{ category: AuditCategory; excerpt: string }> {
  const found = new Map<AuditCategory, { category: AuditCategory; excerpt: string }>();

  for (const [sentenceStart, sentenceEnd] of sentencesWithOffsets(msg)) {
    const sentence = msg.slice(sentenceStart, sentenceEnd);
    // Derivar al equipo no es mutar: la frase entera queda fuera de sospecha.
    if (HANDOFF_GUARD.test(sentence)) continue;
    const isQuestion = /[¿?]/.test(sentence);

    for (const [clauseStart, clauseEnd] of clausesWithOffsets(sentence, sentenceStart)) {
      const clause = msg.slice(clauseStart, clauseEnd);
      // Cláusula que sólo habla de los datos de la reserva en curso.
      if (BOOKING_DATUM.test(clause) && !APPOINTMENT_NOUN.test(clause)) continue;

      for (const rule of SCOPE_RULES) {
        if (found.has(rule.category)) continue;
        if (rule.onlyInQuestion && !isQuestion) continue;
        const match = rule.pattern.exec(clause);
        if (match === null) continue;
        const end = match.index + match[0].length;
        if (negatedBefore(clause, end)) continue;
        found.set(rule.category, {
          category: rule.category,
          excerpt: excerpt(msg, clauseStart + match.index, clauseStart + end),
        });
      }
    }
  }

  return [...found.values()];
}

// ---------------------------------------------------------------------
// AVISO AL EQUIPO SIN RESPALDO · LA ÚNICA REGLA QUE MIRA LOS RESULTADOS.
//
// Incidente de origen: en seis simulaciones remotas seguidas, la herramienta
// `booking_human_help` devolvió HTTP 400 y el agente dijo igualmente «Queda el
// aviso al equipo; lo verá una persona de la peluquería, aunque no puedo
// confirmarte desde aquí cuándo». Anunció como registrado un aviso que NADIE
// registró: al cliente se le manda a esperar una llamada que no existe. Es
// mentira aunque cada palabra suene impecable, y por eso ninguna regla de
// texto podía cazarla — el texto es exactamente el mismo que en el caso
// bueno. La diferencia está en los RESULTADOS de las herramientas, y ésta es
// la única regla del módulo que los lee.
//
// `unsupportedHumanHelpClaim` = un turno de agente AFIRMA como hecho que el
// aviso al equipo queda registrado, y en el transcript NO hay —ni en ese
// turno ni en ninguno anterior— un resultado de `booking_human_help` que lo
// respalde.
//
// «RESPALDA» se define con la forma real que traen los datos de ElevenLabs
// (`tool_name`, `is_error`, `result_value` como cadena que suele contener
// JSON), y deliberadamente a favor del agente: sólo se le acusa cuando la
// evidencia de que NO hubo aviso es clara. Ver {@link isSupportingHelpResult}
// para el detalle, incluidas las dos únicas maneras de perder el respaldo
// (`is_error` verdadero, o un `result_value` que dice `help_requested:false`)
// y por qué el `ok:false` del puente NO es una de ellas.
//
// Tres cautelas contra el falso positivo, cada una con su defensa:
//
//   1. La OFERTA y el FUTURO no son afirmaciones. «Si quieres, puedo dejar
//      aviso al equipo», «¿quieres que deje constancia?», «voy a dejar
//      constancia», «ahora aviso al equipo» — todas ellas hablan de algo que
//      aún no ha pasado, y ninguna miente. Defensa: el léxico sólo admite
//      PERFECTO («he dejado», «he avisado») y ESTADO RESULTANTE («queda el
//      aviso», «el aviso está hecho»). Ni el presente, ni el infinitivo, ni
//      la perífrasis de futuro, ni el subjuntivo entran. Esto deja fuera
//      también, de propina, la frase pre-tool del guion.
//   2. El RECONOCIMIENTO HONESTO del fallo dice casi las mismas palabras con
//      un «no» delante: «no he podido dejar el aviso», «no ha quedado
//      registrado el aviso». Castigar eso sería exactamente al revés de lo
//      que queremos. Defensa doble: {@link NEGATOR} por CLÁUSULA, como en el
//      alcance —y por la misma cicatriz: aquí ya se pagó una vez un falso
//      positivo por dejar que la negación cayera DENTRO del tramo casado—, y
//      patrones sin huecos elásticos, de modo que «el aviso no ha quedado
//      registrado» ni siquiera llegue a casar.
//   3. La FRASE PREVIA legítima, la que se dice mientras se llama a la
//      herramienta. Defensa: si el propio turno invoca `booking_human_help`,
//      la categoría no se evalúa en él; lo que se diga ahí precede al
//      resultado por construcción, no lo relata.
//
// Y una cautela contra el falso positivo MASIVO: si el transcript no trae
// `tool_results` en ningún turno, esta regla NO OPINA. Sin resultados no se
// distingue «no hubo aviso» de «no me han contado si lo hubo», y acusar por
// falta de datos convertiría en sospechosa cualquier transcripción antigua o
// recortada. Callar es aquí lo correcto: es el mismo criterio de fondo que en
// el resto del módulo — señalar sólo lo que se puede demostrar.
// ---------------------------------------------------------------------

/** El nombre con el que ElevenLabs conoce la herramienta de ayuda humana. */
const HUMAN_HELP_TOOL = "booking_human_help";

/** Derivación a la persona: quién recibe el aviso. */
const HELP_TEAM =
  "(?:al\\s+equipo|a\\s+la\\s+peluquer[íi]a|al\\s+sal[óo]n|para\\s+el\\s+equipo" +
  "|a\\s+una\\s+persona(?:\\s+(?:del\\s+equipo|de\\s+la\\s+peluquer[íi]a|del\\s+sal[óo]n))?)";

/** El aviso en sí, con determinante y destinatario opcionales. */
const HELP_NOTICE =
  "(?:(?:el|la|un|una|tu|su|ese|esa|mi)\\s+)?" +
  "(?:aviso|constancia|recado|nota|solicitud(?:\\s+de\\s+ayuda(?:\\s+humana)?)?" +
  "|petici[óo]n(?:\\s+de\\s+ayuda(?:\\s+humana)?)?)" +
  `(?:\\s+${HELP_TEAM})?`;

/** Participios de REGISTRAR el aviso. Son la marca del hecho consumado. */
const HELP_DONE_PART = "(?:dejado|avisado|pasado|trasladado|registrado|comunicado|anotado|apuntado)";

/** Participios de ESTADO: «el aviso está hecho», «ha quedado registrado». */
const HELP_DONE_STATE =
  "(?:hech[oa]s?|registrad[oa]s?|puest[oa]s?|dad[oa]s?|enviad[oa]s?|anotad[oa]s?|guardad[oa]s?|apuntad[oa]s?|dejad[oa]s?)";

/**
 * Afirmaciones de que el aviso YA está hecho. Sin huecos elásticos entre las
 * piezas, a propósito: es lo que impide que una negación quede absorbida.
 */
const HELP_CLAIM_PATTERNS: readonly RegExp[] = [
  // «ya he avisado al equipo», «he dejado constancia», «se lo he pasado al equipo».
  scopePattern(
    `(?:ya\\s+)?(?:(?:se|te|os)\\s+)?(?:l[oa]s?\\s+|le\\s+|les\\s+)?(?:he|hemos|ha|han)\\s+` +
      `${HELP_DONE_PART}\\s+(?:${HELP_NOTICE}|${HELP_TEAM})`,
  ),
  // «Queda el aviso al equipo», «queda constancia», «ya quedan las notas».
  scopePattern(`(?:ya\\s+)?(?:queda|quedan)\\s+${HELP_NOTICE}`),
  // «el aviso está hecho», «tu solicitud ha quedado registrada».
  scopePattern(`${HELP_NOTICE}\\s+(?:ya\\s+)?(?:est[áa]|queda|(?:ha|han)\\s+(?:quedado|sido))\\s+${HELP_DONE_STATE}`),
  // «ha quedado registrado el aviso», «ya está hecha la solicitud de ayuda».
  scopePattern(
    `(?:ya\\s+)?(?:queda|quedan|est[áa]|est[áa]n|(?:ha|han)\\s+(?:quedado|sido))\\s+${HELP_DONE_STATE}\\s+${HELP_NOTICE}`,
  ),
  // «ya está avisado el equipo», «queda avisada la peluquería».
  scopePattern(
    `(?:ya\\s+)?(?:queda|quedan|est[áa]|est[áa]n)\\s+(?:avisad|informad)[oa]s?\\s+` +
      "(?:el\\s+equipo|la\\s+peluquer[íi]a|el\\s+sal[óo]n|una\\s+persona)",
  ),
];

/** Estrechamiento mínimo: los elementos de `tool_results` llegan como `unknown`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * ¿El `result_value` es un JSON que dice EXPLÍCITAMENTE que no se pidió ayuda?
 * Sólo eso cuenta: un `result_value` que no sea JSON —o que lo sea y no hable
 * de `help_requested`— no prueba ningún fallo y no se usa para acusar.
 */
function deniesHelpRequested(resultValue: unknown): boolean {
  if (typeof resultValue !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultValue);
  } catch {
    return false; // No es JSON: no inventamos un fallo que nadie ha declarado.
  }
  return isRecord(parsed) && parsed.help_requested === false;
}

/**
 * ¿Este elemento de `tool_results` respalda que el aviso quedó registrado?
 *
 * Respalda si es de `booking_human_help` y NO es un error. `is_error` ausente
 * cuenta como «no es error»: ElevenLabs sólo lo pone cuando lo hay.
 *
 * Ojo con lo que NO invalida el respaldo: el puente responde a esta
 * herramienta con `ok:false` y `reason_code:"CUSTOMER_REQUESTS_HUMAN"` — «no
 * he podido resolverlo yo, lo escalo» — incluso cuando el aviso se registra
 * perfectamente. Leer ese `ok:false` como fallo marcaría como mentira TODAS
 * las llamadas buenas. La única señal de que el aviso no existe, dentro del
 * cuerpo, es `help_requested:false`.
 */
function isSupportingHelpResult(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (item.tool_name !== HUMAN_HELP_TOOL) return false;
  if (item.is_error === true || item.is_error === "true") return false;
  if (deniesHelpRequested(item.result_value)) return false;
  return true;
}

/** ¿Trae el transcript resultados de herramienta? Si no, esta regla no opina. */
function carriesToolResults(turns: TranscriptTurns): boolean {
  return turns.some((turn) => Array.isArray(turn.tool_results));
}

/** ¿Hay un resultado de ayuda humana sin error hasta el turno `idx` INCLUSIVE? */
function helpBackedThrough(turns: TranscriptTurns, idx: number): boolean {
  for (let i = 0; i <= idx; i += 1) {
    const results = turns[i]?.tool_results;
    if (!Array.isArray(results)) continue;
    if (results.some(isSupportingHelpResult)) return true;
  }
  return false;
}

/** ¿Este turno invoca `booking_human_help`? Entonces lo que diga es la frase previa. */
function turnInvokesHumanHelp(turn: TranscriptTurn | undefined): boolean {
  const calls = turn?.tool_calls;
  if (!Array.isArray(calls)) return false;
  return calls.some(
    (call) => isRecord(call) && (call.tool_name === HUMAN_HELP_TOOL || call.name === HUMAN_HELP_TOOL),
  );
}

/**
 * El primer tramo de `msg` que AFIRMA el aviso como hecho, o `null`. Se
 * recorre por frases y, dentro de cada frase, por cláusulas: la negación de
 * una cláusula («no he podido dejar el aviso») no absuelve a la de al lado, y
 * el punto no separa cláusulas, así que las frases hay que partirlas antes.
 */
function firstHelpClaim(msg: string): { readonly start: number; readonly end: number } | null {
  for (const [sentenceStart, sentenceEnd] of sentencesWithOffsets(msg)) {
    const sentence = msg.slice(sentenceStart, sentenceEnd);
    for (const [clauseStart, clauseEnd] of clausesWithOffsets(sentence, sentenceStart)) {
      const clause = msg.slice(clauseStart, clauseEnd);
      for (const pattern of HELP_CLAIM_PATTERNS) {
        const match = pattern.exec(clause);
        if (match === null) continue;
        const end = match.index + match[0].length;
        if (negatedBefore(clause, end)) continue;
        return { start: clauseStart + match.index, end: clauseStart + end };
      }
    }
  }
  return null;
}

/**
 * Aviso al equipo dado por hecho sin ningún resultado que lo respalde. Ver el
 * bloque «Aviso al equipo sin respaldo» para el porqué de cada guarda.
 */
function unsupportedHumanHelpClaim(turns: TranscriptTurns, idx: number, msg: string): string | null {
  const claim = firstHelpClaim(msg);
  if (claim === null) return null;
  // Sin resultados en el transcript no hay nada que contrastar: no se opina.
  if (!carriesToolResults(turns)) return null;
  // Hablar mientras se llama a la herramienta es la frase previa, no el relato.
  if (turnInvokesHumanHelp(turns[idx])) return null;
  if (helpBackedThrough(turns, idx)) return null;
  return excerpt(msg, claim.start, claim.end);
}

/** ¿El turno siguiente es una llamada a herramienta? (así se lee la voz alrededor). */
function nextTurnIsToolCall(turns: TranscriptTurns, idx: number): boolean {
  const next = turns[idx + 1];
  return next !== undefined && Array.isArray(next.tool_calls) && next.tool_calls.length > 0;
}

/** Violaciones de contenido en el `message` de UN turno de agente. */
function auditMessage(
  turns: TranscriptTurns,
  idx: number,
  msg: string,
): ReadonlyArray<{ category: AuditCategory; excerpt: string }> {
  const violations: Array<{ category: AuditCategory; excerpt: string }> = [];

  for (const [category, pattern] of RULES) {
    const match = pattern.exec(msg);
    if (match !== null) {
      violations.push({ category, excerpt: excerpt(msg, match.index, match.index + match[0].length) });
    }
  }

  // Alcance del producto: sólo se crean reservas nuevas.
  violations.push(...outOfScopeViolations(msg));

  // Aviso al equipo anunciado como hecho sin resultado que lo respalde.
  const helpClaim = unsupportedHumanHelpClaim(turns, idx, msg);
  if (helpClaim !== null) {
    violations.push({ category: "unsupportedHumanHelpClaim", excerpt: helpClaim });
  }

  // Heurística de longitud tras la frase pre-tool.
  for (const [start, end] of sentencesWithOffsets(msg)) {
    const sentence = msg.slice(start, end);
    if (PRETOOL_MARKER.test(sentence) && PRETOOL_VERB.test(sentence)) {
      if (nextTurnIsToolCall(turns, idx)) {
        const rest = msg.slice(end).trim();
        if (rest.length > 20) {
          violations.push({
            category: "textAfterPretoolPhrase",
            excerpt: excerpt(msg, end, Math.min(msg.length, end + 60)),
          });
        }
      }
      break;
    }
  }

  // Racha de inglés.
  const run = englishRunViolation(msg);
  if (run !== null) {
    violations.push({ category: "englishRun", excerpt: excerpt(msg, run.start, run.end) });
  }

  return violations;
}

// ---------------------------------------------------------------------
// Normalización de entrada
// ---------------------------------------------------------------------

function turnsOf(source: TranscriptSource): TranscriptTurns {
  if (Array.isArray(source)) return source;
  if ("transcript" in source && Array.isArray(source.transcript)) return source.transcript;
  if ("simulated_conversation" in source && Array.isArray(source.simulated_conversation)) {
    return source.simulated_conversation;
  }
  return [];
}

// ---------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------

/**
 * Audita el `message` HABLADO de cada turno de agente y devuelve TODAS las
 * violaciones encontradas, en orden de aparición.
 *
 * Acepta indistintamente la lista de turnos ya extraída, la respuesta cruda
 * de `GET /v1/convai/conversations/{id}` (`{ transcript: [...] }`) o la de
 * `POST simulate-conversation` (`{ simulated_conversation: [...] }`) — ver
 * {@link TranscriptSource}. Los turnos de usuario se ignoran por diseño: sólo
 * lo que el AGENTE pronuncia puede filtrar razonamiento interno. Un
 * `message` vacío o ausente no produce ninguna violación.
 *
 * Casi todas las categorías se deciden con el texto pronunciado y nada más.
 * La excepción es `unsupportedHumanHelpClaim`, que contrasta lo dicho con los
 * `tool_results` del propio transcript; si la fuente no los trae en ningún
 * turno, esa categoría no se evalúa y el resultado es idéntico al de antes de
 * que existiera.
 *
 * Función PURA: no muta `source`, no lanza por contenido sospechoso, no hace
 * I/O. El uso previsto es post-mortem sobre una transcripción ya descargada,
 * o en un test que fija el fixture del incidente y exige cero violaciones en
 * las transcripciones limpias.
 */
export function auditSpokenMessages(source: TranscriptSource): AuditViolation[] {
  const turns = turnsOf(source);
  const violations: AuditViolation[] = [];

  turns.forEach((turn, idx) => {
    if (turn.role !== "agent") return;
    const msg = turn.message ?? "";
    if (msg.trim() === "") return;
    for (const violation of auditMessage(turns, idx, msg)) {
      violations.push({ turnIndex: idx, ...violation });
    }
  });

  return violations;
}
