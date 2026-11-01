/**
 * ────────────────────────────────────────────────────────────────────────
 * step 20 · B — CATÁLOGO CANÓNICO DE DECISIONES, DE SOLO LECTURA
 * ((internal doc, not included in the template) §2; fuente humana de verdad:
 * docs/operator_console/DECISION_PACK_TEMPLATE.md, D20-3).
 *
 * El catálogo es DATOS, cerrados, inmutables y de solo lectura: 32 entradas
 * que cubren 33 identificadores (32 J/K en 31 entradas, porque J5 y K1
 * comparten respuesta —D20-10—, más L1). Se construye UNA sola vez al cargar
 * el módulo, se congela en profundidad (I20-12) y se valida con las ocho
 * reglas del §2.9: si la validación falla, este módulo LANZA y el proceso no
 * arranca — que es exactamente donde se quiere el fallo, no delante de Bruno.
 *
 * REGLA DURA DE TODO ESTE MÓDULO: no hay ninguna operación de escritura. No
 * existe una función que acepte una respuesta, ni un campo donde guardarla,
 * ni una ruta que la reciba (I20-1). Que el taller no pueda responder por
 * Bruno no es una promesa de la interfaz: es una propiedad del tipo.
 *
 * Texto: cada celda se copia del pack VERBATIM tras las DOS únicas
 * normalizaciones autorizadas (§2.8): N1 (quitar el énfasis `**texto**`) y
 * N2 (quitar el código en línea con acentos graves). Ninguna más: las
 * cursivas de un solo asterisco («*simulado*», la aclaración de J5/K1) se
 * conservan tal cual, porque una tercera normalización sería una
 * normalización no autorizada. La prueba de deriva
 * (tests/console/decisionCatalog.test.ts, §2.11) relee el pack del disco con
 * las mismas dos normalizaciones y compara carácter a carácter: si los dos
 * divergen, la prueba falla y MANDA EL PACK.
 *
 * Las dos canonizaciones de dependencias (D20-15) son EXPLÍCITAS en estos
 * literales, nunca una función que adivine:
 *   - «K1» a secas (K2, J9, K5) → «J5/K1»;
 *   - la autodependencia de J12 (PACK:255, «J13, J12») se elimina:
 *     `dependsOn` de J12 es exactamente ["J13"] (prerrequisito documental,
 *     Apéndice B fila 1 del diseño).
 * La opción (B) de J10 lleva la redacción ratificada por D20-55 (PACK:264):
 * mismo significado, sin el verbo que una prueba vigente reserva para
 * negarlo (I20-17).
 * ────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------
// Tipos de dominio (§2.2)
// ---------------------------------------------------------------------

/** Urgencia, con la redacción LITERAL del pack conservada aparte del tipo. */
export type DecisionUrgencyKind = "bloquea" | "puede_esperar";

export interface DecisionUrgency {
  readonly kind: DecisionUrgencyKind;
  /**
   * La celda «Clasificación» del pack, VERBATIM tras N1/N2 (§2.8). Ejemplos:
   * «BLOQUEA — un piloto real no puede decirle a un cliente un plazo que
   * Demo Salon no ha aprobado»; «PUEDE ESPERAR»; «PUEDE ESPERAR (bloquea sólo si
   * K1 elige una consecuencia que necesite historial por persona)».
   */
  readonly label: string;
}

/** Una opción del pack. 2 o 3 por entrada, letras consecutivas desde «A». */
export interface DecisionOption {
  readonly letter: "A" | "B" | "C";
  /** El texto de la opción, VERBATIM. Nunca se acorta, nunca se resume (D20-8). */
  readonly text: string;
}

export interface DecisionBlock {
  /** «bloque-1» … «bloque-9», «apendice-l». Estable, nunca traducido. */
  readonly id: string;
  /** 1..9 según el §3 del pack; `null` para el apéndice L (R4-12). */
  readonly number: number | null;
  /**
   * El rótulo del §3 del pack, SIN el número. NO es la identidad del bloque
   * (D20-13). Se llama `label` y NUNCA `name`: la lista negra de datos
   * personales de tests/console/console.test.ts prohíbe toda clave que
   * CONTENGA la subcadena «name» y recorre la instantánea entera (R4-3,
   * I20-16).
   */
  readonly label: string;
  /** El párrafo «*Contexto:*» del §3, si el bloque lo tiene. */
  readonly context?: string;
  /** 1..9 según el §5 del pack; `null` para el apéndice L. */
  readonly facilitationOrder: number | null;
  /**
   * «1.º de 9» / «Apéndice», YA compuesto en el servidor, para que el
   * navegador nunca conjugue un ordinal (R4-12, E20-1).
   */
  readonly facilitationOrdinalLabel: string;
  /** La celda «Por qué en este orden» del §5, VERBATIM. */
  readonly facilitationReason: string;
  /** La celda «Tiempo estimado» del §5, en minutos. */
  readonly estimatedMinutes: number;
  /** Línea del pack donde empieza el bloque en el §3 (o el §4 para L). */
  readonly packLine: number;
}

export interface DecisionEntry {
  /**
   * Identidad de la ENTRADA (un grupo de respuesta). «J1», «J5/K1», «L1».
   * Es la clave de reconciliación del DOM y la clave del borrador.
   */
  readonly entryId: string;
  /**
   * Los identificadores que esta entrada satisface. Uno en 31 entradas; DOS
   * en «J5/K1» (D20-10). El denominador de cobertura cuenta ESTO, no
   * entradas.
   */
  readonly identifiers: readonly string[];
  /**
   * 1..32. Orden canónico, explícito, del §2.7. SE QUEDA EN EL DOMINIO y no
   * se publica en la vista (D20-56): el orden viaja en la posición del array
   * `entries`, que el servidor emite ya ordenado. Publicarlo serializaría
   * «"order":12» (K2) y activaría el barrido de la suma prohibida A4+B9+C4.
   */
  readonly order: number;
  readonly blockId: string;
  /** La celda «Pregunta» del pack, VERBATIM. */
  readonly question: string;
  /**
   * La aclaración entre paréntesis en cursiva que algunas preguntas llevan,
   * separada para que no ensucie el nombre accesible. La prueba de deriva
   * compara la RECONSTITUCIÓN `question + " " + questionAside` (§2.11) —
   * SIEMPRE contra este verbatim, asteriscos de Markdown incluidos; lo que
   * la pantalla pinta es la variante `questionAsideDisplay` de la vista,
   * sin asteriscos (revisión U11-4, 2026-08-06), y no entra aquí jamás.
   */
  readonly questionAside?: string;
  /** La celda «Comportamiento hoy (evidencia)», VERBATIM. */
  readonly currentBehaviour: string;
  /**
   * Presente SÓLO donde el pack afirma que algo no existe en ningún sitio
   * (§2.5: J8, J9, K4, K13, K15, K12, L1). Texto propio de este catálogo,
   * escrito a mano entrada por entrada y revisado contra el §1.3 del pack;
   * nunca se infiere en tiempo de ejecución (D20-9).
   */
  readonly notImplementedNote?: string;
  readonly options: readonly DecisionOption[];
  /** `entryId`s de este mismo catálogo. Ya CANONIZADOS (§2.10, D20-15). */
  readonly dependsOn: readonly string[];
  /**
   * Las menciones de la celda «Depende de» que NO son identificadores del
   * catálogo, VERBATIM. Contexto real de la conversación; NUNCA entran en el
   * grafo de dependencias, nunca bloquean nada.
   */
  readonly externalDependencies: readonly string[];
  readonly urgency: DecisionUrgency;
  /** Línea EXACTA de la fila en DECISION_PACK_TEMPLATE.md. */
  readonly packLine: number;
}

export interface DecisionCatalogTotals {
  readonly entries: 32;
  readonly jkEntries: 31;
  readonly jkIdentifiers: 32;
  readonly lIdentifiers: 1;
  readonly blockingEntries: 6;
  /**
   * Las filas bloqueantes son SEIS pero cubren SIETE identificadores (J6,
   * J5, K1, J8, K4, K13, K15), porque la fila combinada lleva dos. Las dos
   * cifras se publican por separado y con nombres distintos para que ninguna
   * pantalla pueda confundirlas (I20-2).
   */
  readonly blockingIdentifiers: 7;
}

export interface DecisionCatalog {
  readonly version: string;
  readonly sourceDocument: string;
  readonly blocks: readonly DecisionBlock[];
  readonly entries: readonly DecisionEntry[];
  readonly totals: DecisionCatalogTotals;
}

// ---------------------------------------------------------------------
// Constantes de identidad y recuento
// ---------------------------------------------------------------------

export const CATALOG_VERSION = "step 20 · catálogo v1";
export const CATALOG_SOURCE_DOCUMENT = "docs/operator_console/DECISION_PACK_TEMPLATE.md";

/**
 * D20-14 — Las SEIS componentes fuertemente conexas no triviales del grafo
 * `dependsOn`, verificadas nodo a nodo sobre el pack. Son dependencias
 * mutuas escritas a propósito: prohibirlas sería rechazar la verdad, y
 * declararlas sin re-derivarlas sería una puerta trasera — por eso la prueba
 * de deriva (§2.11, paso 7) las vuelve a derivar del propio pack antes de
 * creérselas. La coincidencia exigida es EXACTA como conjunto, en las dos
 * direcciones: una componente que crezca falla, y una que mengüe también.
 */
export const COMPONENTES_CONOCIDAS: readonly (readonly string[])[] = [
  ["J5/K1", "K2", "K5", "J9", "K17", "K6"],
  ["J1", "J4"],
  ["J8", "J14"],
  ["K4", "K15"],
  ["J11", "K7"],
  ["K9", "K16"],
];

// ---------------------------------------------------------------------
// Los datos literales: 10 bloques y 32 entradas, espejo tipado del pack.
// Generados una vez desde el fichero del pack (N1/N2 + canonización D20-15)
// y revisados a mano; la prueba de deriva los re-compara en cada ejecución.
// ---------------------------------------------------------------------
const BLOQUES: readonly DecisionBlock[] = [
  {
    id: "bloque-1",
    number: 1,
    label: "Prioridad, orden y adjudicación en la lista de espera",
    context:
      "cuando un hueco se libera y varias personas encajan, hoy nadie decide por quién empezar: el operador ve la lista entera, en orden de apuntarse, y elige.",
    facilitationOrder: 6,
    facilitationOrdinalLabel: "6.º de 9",
    facilitationReason: "Puede esperar, pero es intuitiva y se decide rápido una vez fresca la cabeza",
    estimatedMinutes: 20,
    packLine: 160,
  },
  {
    id: "bloque-2",
    number: 2,
    label: "Caducidad, plazos y tiempos",
    context:
      "hoy nada caduca solo en esta demostración: el reloj es sintético y sólo lo mueve una persona.",
    facilitationOrder: 4,
    facilitationOrdinalLabel: "4.º de 9",
    facilitationReason: "J6 bloquea (el plazo de cancelación real); las otras tres pueden esperar pero encajan en el mismo hueco de conversación",
    estimatedMinutes: 20,
    packLine: 173,
  },
  {
    id: "bloque-3",
    number: 3,
    label: "Depósitos y dinero",
    context:
      "no hay dinero en ningún sitio de esta consola: ni modelo, ni ruta, ni campo, ni control apagado que lo insinúe. Hay un documento de diseño futuro escrito y ni una línea implementada (internal doc, not included in the template).",
    facilitationOrder: 5,
    facilitationOrdinalLabel: "5.º de 9",
    facilitationReason: "Una sola pregunta, pero con mucha cola de trabajo detrás si la respuesta es \"sí\": mejor saberlo pronto",
    estimatedMinutes: 15,
    packLine: 185,
  },
  {
    id: "bloque-4",
    number: 4,
    label: "Inasistencias y cancelaciones tardías: consecuencias",
    context:
      "hoy una inasistencia y una cancelación tardía son datos, no sanciones: se anotan, se pueden corregir (la inasistencia) o revisar (la cancelación tardía), y no cambian nada más en el sistema.",
    facilitationOrder: 1,
    facilitationOrdinalLabel: "1.º de 9",
    facilitationReason: "Es la pregunta que más se repite en las conversaciones con el responsable del negocio, y bloquea un piloto real",
    estimatedMinutes: 30,
    packLine: 196,
  },
  {
    id: "bloque-5",
    number: 5,
    label: "Grupos y reservas para varias personas",
    context:
      "una reserva para varias personas es hoy N reservas normales de 30 minutos con una referencia que las une; el motor de reservas no sabe que existe un \"grupo\".",
    facilitationOrder: 7,
    facilitationOrdinalLabel: "7.º de 9",
    facilitationReason: "La más larga en número de preguntas, pero cada una es de refinamiento, no de bloqueo",
    estimatedMinutes: 25,
    packLine: 209,
  },
  {
    id: "bloque-6",
    number: 6,
    label: "Aviso y contacto",
    context:
      "hoy nadie es contactado de verdad por ninguna función de esta consola. El verbo \"enviar\" no aparece en su vocabulario; todo aviso es *simulado* y lo dice en pantalla.",
    facilitationOrder: 2,
    facilitationOrdinalLabel: "2.º de 9",
    facilitationReason: "Corta, pero bloquea: sin canal real, recuperar un hueco no llega a nadie de verdad",
    estimatedMinutes: 15,
    packLine: 224,
  },
  {
    id: "bloque-7",
    number: 7,
    label: "Datos, identidad, permisos y retención",
    context:
      "hoy no hay identidad de cliente (sólo etiquetas sintéticas), no hay usuarios de la consola (un solo operador sin nombre) y nada se conserva más allá de la memoria del proceso.",
    facilitationOrder: 3,
    facilitationOrdinalLabel: "3.º de 9",
    facilitationReason: "Bloquea por ley, no por preferencia; conviene decidirlo pronto y no al final, cansados",
    estimatedMinutes: 25,
    packLine: 234,
  },
  {
    id: "bloque-8",
    number: 8,
    label: "Alcance de la disponibilidad y del explorador",
    context:
      "hoy el explorador de huecos y la lista de espera son dos mundos que no se tocan: el explorador no sabe que la lista de espera existe, y viceversa.",
    facilitationOrder: 8,
    facilitationOrdinalLabel: "8.º de 9",
    facilitationReason: "Todas pueden esperar; J13 en particular es una decisión de arquitectura, no urgente",
    estimatedMinutes: 20,
    packLine: 247,
  },
  {
    id: "bloque-9",
    number: 9,
    label: "Cruce entre inasistencias, lista de espera y otros",
    facilitationOrder: 9,
    facilitationOrdinalLabel: "9.º de 9",
    facilitationReason: "Cierre natural: son preguntas de detalle sobre bloques ya hablados",
    estimatedMinutes: 15,
    packLine: 260,
  },
  {
    id: "apendice-l",
    number: null,
    label: "pregunta nueva de step 19",
    facilitationOrder: null,
    facilitationOrdinalLabel: "Apéndice",
    facilitationReason: "Encaja bien al final del bloque 4, si hay tiempo, o suelta al final de la sesión",
    estimatedMinutes: 10,
    packLine: 270,
  },
];

const ENTRADAS: readonly DecisionEntry[] = [
  {
    entryId: "J5/K1",
    identifiers: ["J5", "K1"],
    order: 1,
    blockId: "bloque-4",
    question:
      "¿Qué consecuencia tiene una inasistencia, o una cancelación fuera de plazo?",
    questionAside:
      "*(las dos preguntas comparten la misma respuesta conservadora y se tratan juntas)*",
    currentBehaviour:
      "Ninguna. El modelo no tiene ningún campo donde escribir una consecuencia: no hay severity, ni contador, ni marca, ni tarea humana nueva por ello. Una revisión de cancelación tardía sólo tiene una opción: \"Revisada, sin acción\"",
    options: [
      {
        letter: "A",
        text:
          "Ninguna consecuencia automática, nunca: la decisión (si la hay) la toma siempre una persona, caso a caso, fuera de este sistema.",
      },
      {
        letter: "B",
        text:
          "Se registra un contador visible sólo al operador (sin ninguna acción automática que dependa de él).",
      },
      {
        letter: "C",
        text:
          "Tras un número de veces, el sistema avisa al operador para que decida algo (sin decidir por él)",
      },
    ],
    dependsOn: ["K2", "K3", "K5", "K17", "J9"],
    externalDependencies: [],
    urgency: {
      kind: "bloquea",
      label:
        "BLOQUEA — sin respuesta, un piloto real no sabe qué decir a un cliente que ha faltado o cancelado tarde",
    },
    packLine: 204,
  },
  {
    entryId: "K3",
    identifiers: ["K3"],
    order: 2,
    blockId: "bloque-4",
    question:
      "¿Puede volver a marcarse como inasistencia un registro ya corregido?",
    currentBehaviour:
      "No: la corrección es terminal hasta el reinicio; un segundo intento da 409 no_show_already_corrected sin escribir nada, y la interfaz ni siquiera ofrece el botón",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: corregir es definitivo.",
      },
      {
        letter: "B",
        text:
          "Se permite deshacer una corrección con una segunda confirmación explícita (más pasos, más riesgo de reescribir historia)",
      },
    ],
    dependsOn: [],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 205,
  },
  {
    entryId: "K6",
    identifiers: ["K6"],
    order: 3,
    blockId: "bloque-4",
    question:
      "¿Pueden coexistir una cancelación y una inasistencia sobre la misma cita?",
    currentBehaviour:
      "Sí: una cita con inasistencia se puede cancelar después, y una cancelada conserva su registro de inasistencia si ya lo tenía",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: los dos hechos pueden coexistir, cada uno con su fecha.",
      },
      {
        letter: "B",
        text:
          "Cancelar borra cualquier inasistencia previa (perdería información real)",
      },
    ],
    dependsOn: ["K17"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 206,
  },
  {
    entryId: "K17",
    identifiers: ["K17"],
    order: 4,
    blockId: "bloque-4",
    question:
      "Si alguien canceló fuera de plazo y además no se presentó, ¿son dos hechos o uno?",
    currentBehaviour:
      "Dos, y sólo se registra el primero: no se puede anotar inasistencia sobre una cita ya cancelada (409 reservation_is_cancelled); queda la cancelación tardía y nada más",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: son dos hechos distintos, y una cita cancelada no puede además \"no presentarse\".",
      },
      {
        letter: "B",
        text:
          "Se permite registrar los dos si de verdad ocurrieron los dos (exigiría redefinir qué significa \"cancelada\")",
      },
    ],
    dependsOn: ["J5/K1", "K6"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 207,
  },
  {
    entryId: "J8",
    identifiers: ["J8"],
    order: 5,
    blockId: "bloque-6",
    question:
      "¿Por qué canal se avisaría de verdad a alguien de la lista de espera, y con qué texto exacto?",
    currentBehaviour:
      "Ninguno: «Aviso simulado. No se ha enviado ningún mensaje ni se ha llamado a nadie.» en todas las superficies (WAITLIST_COPY.simulatedNoticeOnly)",
    notImplementedNote:
      "No existe ningún canal de aviso: ninguna integración, ninguna plantilla y ningún envío real de un mensaje. Todo aviso es simulado y lo dice en pantalla.",
    options: [
      {
        letter: "A",
        text:
          "Llamada de teléfono, hecha por una persona del equipo (como hoy, pero de verdad).",
      },
      {
        letter: "B",
        text:
          "SMS o WhatsApp automático con una plantilla fija.",
      },
      {
        letter: "C",
        text:
          "El propio asistente de voz llama para ofrecer el hueco (exigiría un desenlace nuevo en el contrato congelado del piloto, hoy no existe ninguno honesto para esto)",
      },
    ],
    dependsOn: ["J14"],
    externalDependencies: [],
    urgency: {
      kind: "bloquea",
      label:
        "BLOQUEA — sin canal real no hay forma de que un hueco recuperado llegue de verdad a nadie fuera de esta demostración",
    },
    packLine: 232,
  },
  {
    entryId: "K4",
    identifiers: ["K4"],
    order: 6,
    blockId: "bloque-7",
    question:
      "¿Quién tiene permiso para anotar una inasistencia, corregirla, o cerrar una tarea humana?",
    currentBehaviour:
      "No hay usuarios: un operador sin identidad; recordedBy: \"console-operator\" es un valor fijo en el código",
    notImplementedNote:
      "No existen usuarios ni identidad de operador en esta consola: recordedBy es un valor fijo del código.",
    options: [
      {
        letter: "A",
        text:
          "Cualquier persona con acceso a la consola puede hacer cualquier acción (como hoy, ampliado a producción).",
      },
      {
        letter: "B",
        text:
          "Se añaden roles (p. ej. sólo encargados pueden corregir un registro).",
      },
      {
        letter: "C",
        text:
          "Se añade identidad individual (quién exactamente hizo cada cosa) sin roles distintos",
      },
    ],
    dependsOn: ["K15"],
    externalDependencies: [],
    urgency: {
      kind: "bloquea",
      label:
        "BLOQUEA — un sistema con datos reales y varias personas usándolo no puede seguir sin ninguna identidad",
    },
    packLine: 242,
  },
  {
    entryId: "K5",
    identifiers: ["K5"],
    order: 7,
    blockId: "bloque-7",
    question:
      "¿Una inasistencia va pegada a una persona, o a la cita?",
    currentBehaviour:
      "A la cita sintética: la relación es sólo reservationId, no hay ningún campo que sume por persona. Es una decisión estructural: no hay ninguna cifra por persona en ningún resumen (imposible por construcción)",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene pegada a la cita: nunca se acumula un historial por persona.",
      },
      {
        letter: "B",
        text:
          "Se pega también a la persona (exigiría, primero, tener identidad real de cliente — hoy no existe)",
      },
    ],
    dependsOn: ["J5/K1"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR (bloquea sólo si K1 elige una consecuencia que necesite historial por persona)",
    },
    packLine: 243,
  },
  {
    entryId: "K13",
    identifiers: ["K13"],
    order: 8,
    blockId: "bloque-7",
    question:
      "¿Qué etiquetas se usan para las personas de un grupo?",
    currentBehaviour:
      "Lista cerrada de doce («Persona 1…4», «Adulto A…D», «Menor A…D»); ningún campo de texto libre en ninguna parte",
    notImplementedNote:
      "No existe identidad real de cliente: sólo una lista cerrada de doce etiquetas sintéticas.",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene una lista cerrada, pero con etiquetas reales (nombre y apellido del cliente) una vez exista identidad real.",
      },
      {
        letter: "B",
        text:
          "Se amplía la lista sintética sin llegar a nombre real (p. ej. más etiquetas, o roles familiares)",
      },
    ],
    dependsOn: ["K4"],
    externalDependencies: ["identidad real (fuera de las tres misiones)"],
    urgency: {
      kind: "bloquea",
      label:
        "BLOQUEA — con clientes reales, \"Adulto A\" deja de tener sentido y hay que decidir qué dato identifica a cada persona",
    },
    packLine: 244,
  },
  {
    entryId: "K15",
    identifiers: ["K15"],
    order: 9,
    blockId: "bloque-7",
    question:
      "¿Cuánto tiempo se conserva un registro (inasistencia, tarea humana, historial de lista de espera), y quién puede verlo?",
    currentBehaviour:
      "No se conserva nada: todo vive en memoria del proceso, y el reinicio lo borra entero. No hay política de retención, ni de acceso, ni derecho de supresión",
    notImplementedNote:
      "No existe política de retención, ni de acceso, ni derecho de supresión: todo vive en memoria del proceso, sin identidad real de cliente detrás.",
    options: [
      {
        letter: "A",
        text:
          "Se define un plazo de conservación fijo (p. ej. X meses) y luego se borra.",
      },
      {
        letter: "B",
        text:
          "Se conserva indefinidamente, con acceso restringido por rol.",
      },
      {
        letter: "C",
        text:
          "Se conserva sólo lo agregado (cifras), no el detalle individual, pasado cierto tiempo",
      },
    ],
    dependsOn: ["K4"],
    externalDependencies: [],
    urgency: {
      kind: "bloquea",
      label:
        "BLOQUEA — con datos reales, esto es una obligación legal (protección de datos), no una preferencia de producto",
    },
    packLine: 245,
  },
  {
    entryId: "J2",
    identifiers: ["J2"],
    order: 10,
    blockId: "bloque-2",
    question:
      "¿Caducan las ofertas de un hueco liberado? ¿En cuánto tiempo?",
    currentBehaviour:
      "No caduca nada automáticamente; sólo existe una caducidad manual, a mano del operador (expire_manually)",
    options: [
      {
        letter: "A",
        text:
          "Nunca caduca sola: siempre a mano.",
      },
      {
        letter: "B",
        text:
          "Caduca tras un tiempo fijo (p. ej. 30 o 60 minutos) si nadie confirma.",
      },
      {
        letter: "C",
        text:
          "Caduca al cerrar el local ese mismo día, nunca antes",
      },
    ],
    dependsOn: ["J1"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 180,
  },
  {
    entryId: "J6",
    identifiers: ["J6"],
    order: 11,
    blockId: "bloque-2",
    question:
      "¿Es correcto el plazo de 120 minutos para considerar una cancelación \"a tiempo\"? ¿Es el mismo para todo servicio y todo profesional?",
    currentBehaviour:
      "120 minutos es un valor de demostración, único para todo el local, configurable desde la propia pantalla (DEFAULT_CANCELLATION_NOTICE_MINUTES)",
    options: [
      {
        letter: "A",
        text:
          "Se confirma 120 minutos como el plazo real de Demo Salon, igual para todos.",
      },
      {
        letter: "B",
        text:
          "Se fija un plazo distinto (a decidir).",
      },
      {
        letter: "C",
        text:
          "El plazo varía por servicio o por profesional (más complejo de operar y de explicar al cliente)",
      },
    ],
    dependsOn: ["K2", "K17"],
    externalDependencies: [],
    urgency: {
      kind: "bloquea",
      label:
        "BLOQUEA — un piloto real no puede decirle a un cliente un plazo que Demo Salon no ha aprobado",
    },
    packLine: 181,
  },
  {
    entryId: "K2",
    identifiers: ["K2"],
    order: 12,
    blockId: "bloque-2",
    question:
      "¿Cuántos minutos de retraso convierten \"ha llegado tarde\" en \"no se ha presentado\"?",
    currentBehaviour:
      "Cero, y no es un parámetro: es elegible en cuanto termina la cita (minutesAfterEnd >= 0), sin ningún margen de cortesía configurable",
    options: [
      {
        letter: "A",
        text:
          "Cero minutos de margen, como hoy.",
      },
      {
        letter: "B",
        text:
          "Un margen fijo (p. ej. 10 o 15 minutos) antes de poder anotar inasistencia.",
      },
      {
        letter: "C",
        text:
          "El margen lo decide el operador caso a caso (con el riesgo de que dos operadores lo apliquen distinto)",
      },
    ],
    dependsOn: ["J5/K1"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 182,
  },
  {
    entryId: "K11",
    identifiers: ["K11"],
    order: 13,
    blockId: "bloque-2",
    question:
      "¿Debe poder retroceder el reloj de la demostración?",
    currentBehaviour:
      "No: advanceMinutes exige un entero positivo y no hay ninguna ruta de retroceso (409 clock_cannot_go_backwards)",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: sólo avanza, nunca retrocede — esto es una decisión de herramienta de demostración, no de producto real (el reloj sintético no existe fuera de esta consola).",
      },
      {
        letter: "B",
        text:
          "Se permite reiniciar a un punto intermedio guardado (más complejidad de la demostración, sin beneficio de producto)",
      },
    ],
    dependsOn: [],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR (no aplica al producto real: el reloj es sólo de esta demo)",
    },
    packLine: 183,
  },
  {
    entryId: "J9",
    identifiers: ["J9"],
    order: 14,
    blockId: "bloque-3",
    question:
      "¿Deben pedirse depósitos para huecos de la lista de espera (o para citas en general)?",
    currentBehaviour:
      "No existen: ni flujo, ni simulación, ni campo, ni control deshabilitado. Sólo un enlace de \"diseño futuro\" en el detalle técnico",
    notImplementedNote:
      "No existen depósitos: ni modelo, ni ruta, ni campo, ni control deshabilitado. Sólo hay un documento de diseño futuro, sin una línea implementada.",
    options: [
      {
        letter: "A",
        text:
          "No se piden depósitos: se confía en la anotación manual de inasistencias como único control.",
      },
      {
        letter: "B",
        text:
          "Se piden depósitos sólo para huecos de la lista de espera (que ya se perdieron una vez).",
      },
      {
        letter: "C",
        text:
          "Se piden depósitos para todas las citas por encima de cierto valor o duración. Cualquiera de (B)/(C) exige elegir proveedor de pago, política de devolución y quién gestiona una disputa — trabajo de producto e integración que no empieza hasta que se elija una opción",
      },
    ],
    dependsOn: ["J5/K1"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR (bloquea sólo si Demo Salon quiere depósitos antes de pilotar; si no, el pilotaje puede empezar sin ellos)",
    },
    packLine: 194,
  },
  {
    entryId: "J1",
    identifiers: ["J1"],
    order: 15,
    blockId: "bloque-1",
    question:
      "¿Qué criterio ordena a varias personas compatibles con el mismo hueco?",
    currentBehaviour:
      "Ninguno decide por el operador: readingOrder es orden de creación, con la nota «Orden de lectura, no de prioridad» en cada pantalla que lo enseña (waitlistSnapshot.ts)",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene el orden de apuntarse, siempre («primero en llegar»).",
      },
      {
        letter: "B",
        text:
          "Se añade un criterio explícito (p. ej. quién lleva más tiempo esperando, o quién pidió primero ese servicio concreto) y se muestra en pantalla.",
      },
      {
        letter: "C",
        text:
          "Se deja la elección siempre a criterio del operador, sin ningún orden sugerido (quitar incluso el orden de creación)",
      },
    ],
    dependsOn: ["J3", "J4"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 168,
  },
  {
    entryId: "J3",
    identifiers: ["J3"],
    order: 16,
    blockId: "bloque-1",
    question:
      "Si sólo hay una persona compatible, ¿puede adjudicarse sola, sin que el operador elija entre varias?",
    currentBehaviour:
      "No cambia nada: sigue exigiendo aviso simulado + aceptación anotada + conversión confirmada, aunque sea la única (applyEntryCommand())",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: siempre tres confirmaciones humanas, haya una candidata o varias.",
      },
      {
        letter: "B",
        text:
          "Con una sola compatible, se salta el paso de \"elegir entre varias\" pero se conservan aviso y confirmación.",
      },
      {
        letter: "C",
        text:
          "Con una sola compatible, el sistema podría marcarla como \"sugerida\" sin decidir por nadie (una etiqueta visual, no una acción)",
      },
    ],
    dependsOn: [],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 169,
  },
  {
    entryId: "J4",
    identifiers: ["J4"],
    order: 17,
    blockId: "bloque-1",
    question:
      "¿Qué pasa si dos personas aceptan el mismo hueco a la vez?",
    currentBehaviour:
      "El segundo intento se rechaza con 409 slot_already_accepted_by_another_entry; no se crea ninguna cola \"en espera\" de un hueco ya aceptado",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: gana quien el operador confirma primero, y ya está.",
      },
      {
        letter: "B",
        text:
          "Se añade una lista de \"candidatas de reserva\" para ese hueco concreto, visible sólo al operador, sin ninguna promesa a nadie.",
      },
      {
        letter: "C",
        text:
          "Se pregunta a la segunda persona si quiere esperar al siguiente hueco similar (requeriría un flujo nuevo)",
      },
    ],
    dependsOn: ["J1"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 170,
  },
  {
    entryId: "J7",
    identifiers: ["J7"],
    order: 18,
    blockId: "bloque-1",
    question:
      "¿Un \"no\" a una oferta saca a la persona de la lista de espera?",
    currentBehaviour:
      "Ni la saca ni la mantiene esperando activamente: queda en un estado latente (declined) hasta que el operador la reactiva o la retira a mano",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: nunca se retira sola, sólo a mano.",
      },
      {
        letter: "B",
        text:
          "Tras N \"noes\" seguidos, se sugiere (sin obligar) retirarla.",
      },
      {
        letter: "C",
        text:
          "Un \"no\" retira automáticamente, y hay que volver a apuntarse si se quiere seguir esperando",
      },
    ],
    dependsOn: [],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 171,
  },
  {
    entryId: "J11",
    identifiers: ["J11"],
    order: 19,
    blockId: "bloque-5",
    question:
      "¿Deben poder reservarse varias personas en un mismo hueco (a la vez, con el mismo profesional)?",
    currentBehaviour:
      "No: dos personas a la vez ocupan siempre dos huecos de dos profesionales distintos; nunca comparten hueco ni profesional",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: cada persona necesita su propio profesional y su propio hueco.",
      },
      {
        letter: "B",
        text:
          "Se permite compartir hueco si el servicio lo permite (p. ej. dos cortes simultáneos con el mismo barbero, si el local lo permite físicamente) — cambiaría el modelo de capacidad del motor",
      },
    ],
    dependsOn: ["K7", "K8"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 217,
  },
  {
    entryId: "K7",
    identifiers: ["K7"],
    order: 20,
    blockId: "bloque-5",
    question:
      "¿Deben las citas consecutivas de un grupo ir con el mismo profesional?",
    currentBehaviour:
      "No se exige nada: cada línea del grupo resuelve la suya; pueden salir con profesionales distintos",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: sin restricción, cada línea busca su mejor opción.",
      },
      {
        letter: "B",
        text:
          "Se prioriza (sin obligar) el mismo profesional cuando sea posible.",
      },
      {
        letter: "C",
        text:
          "Se exige el mismo profesional siempre que el grupo lo pida (puede alargar la espera o dejar huecos sin cubrir)",
      },
    ],
    dependsOn: ["J11"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 218,
  },
  {
    entryId: "K8",
    identifiers: ["K8"],
    order: 21,
    blockId: "bloque-5",
    question:
      "¿Cuántas personas caben en una reserva de grupo?",
    currentBehaviour:
      "De 2 a 4, y como máximo tantas a la vez como profesionales hay (hoy, 3). Es un valor de demostración",
    options: [
      {
        letter: "A",
        text:
          "Se confirma 2–4 como el rango real.",
      },
      {
        letter: "B",
        text:
          "Se amplía el máximo (más personas por grupo, sujeto al número real de profesionales del local).",
      },
      {
        letter: "C",
        text:
          "Se reduce a un rango más estrecho",
      },
    ],
    dependsOn: [],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 219,
  },
  {
    entryId: "K9",
    identifiers: ["K9"],
    order: 22,
    blockId: "bloque-5",
    question:
      "¿Debe existir \"cancelar todo el grupo\" de una vez?",
    currentBehaviour:
      "No: no hay ruta ni botón; se cancela línea a línea, cada cita por separado",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: cancelar es siempre individual, cita a cita.",
      },
      {
        letter: "B",
        text:
          "Se añade un botón \"cancelar todo el grupo\" que cancela cada línea con su propio registro (más superficie de interfaz y de pruebas)",
      },
    ],
    dependsOn: ["K16"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 220,
  },
  {
    entryId: "K10",
    identifiers: ["K10"],
    order: 23,
    blockId: "bloque-5",
    question:
      "¿Debe la lista de espera admitir grupos, no sólo personas sueltas?",
    currentBehaviour:
      "No: una entrada de la lista de espera sigue siendo una persona, un servicio, un hueco",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: la lista de espera es siempre individual.",
      },
      {
        letter: "B",
        text:
          "Se permite apuntar a un grupo entero a la lista de espera, a la espera de que se liberen huecos simultáneos para todos (mucho más complejo de emparejar)",
      },
    ],
    dependsOn: ["J1", "K8"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 221,
  },
  {
    entryId: "K16",
    identifiers: ["K16"],
    order: 24,
    blockId: "bloque-5",
    question:
      "¿Puede un grupo repartirse en días distintos?",
    currentBehaviour:
      "No: el cuerpo de la petición de creación lleva una fecha para todas las líneas del grupo",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: un grupo es siempre del mismo día.",
      },
      {
        letter: "B",
        text:
          "Se permite repartir un grupo en varios días (p. ej. una familia que necesita citas en fechas distintas por disponibilidad)",
      },
    ],
    dependsOn: ["K9"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 222,
  },
  {
    entryId: "J12",
    identifiers: ["J12"],
    order: 25,
    blockId: "bloque-8",
    question:
      "Si un hueco liberado es de 60 minutos, ¿se ofrece entero o partido en dos de 30?",
    currentBehaviour:
      "Partido en dos huecos de 30, porque el motor siempre escribe en bloques de 30 minutos (releasedSlotsFrom())",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: siempre bloques de 30.",
      },
      {
        letter: "B",
        text:
          "Se detecta cuándo un servicio necesita 60 minutos seguidos y se ofrece como un solo bloque (exigiría enseñar al motor a razonar sobre duraciones variables, hoy no lo hace)",
      },
    ],
    dependsOn: ["J13"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 255,
  },
  {
    entryId: "J13",
    identifiers: ["J13"],
    order: 26,
    blockId: "bloque-8",
    question:
      "¿Debe buscarse en el resto de la agenda (no sólo en el hueco recién liberado) para encajar a alguien de la lista de espera?",
    currentBehaviour:
      "No: sólo se mira el hueco que se acaba de liberar; la pantalla lo dice explícitamente",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: sólo el hueco recién liberado.",
      },
      {
        letter: "B",
        text:
          "Se añade un botón para \"buscar en toda la agenda\" desde una entrada de la lista de espera, usando el explorador de step 19 como base — es la línea que esta misión declaró explícitamente que no cruza (rebanada omitida J13)",
      },
    ],
    dependsOn: ["J1"],
    externalDependencies: ["explorador (Capacidad 1)"],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 256,
  },
  {
    entryId: "J14",
    identifiers: ["J14"],
    order: 27,
    blockId: "bloque-8",
    question:
      "¿Puede alguien apuntarse a la lista de espera hablando por teléfono con el asistente de voz?",
    currentBehaviour:
      "No en esta demo: el alta la registra siempre el operador, etiquetando de dónde dice que vino la persona (optInSource)",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: sólo el operador da de alta, nunca el asistente de voz.",
      },
      {
        letter: "B",
        text:
          "El asistente de voz ofrece apuntarse y registra la intención (exigiría un desenlace nuevo en el contrato congelado del piloto — no existe ninguno honesto hoy)",
      },
    ],
    dependsOn: ["J8"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 257,
  },
  {
    entryId: "J15",
    identifiers: ["J15"],
    order: 28,
    blockId: "bloque-8",
    question:
      "¿Puede el operador apuntar a alguien a un rango de fechas imposible (un día que el local tiene cerrado)?",
    currentBehaviour:
      "Sí: se guarda tal cual, sin ninguna predicción de si \"eso va a pasar\" o no",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: se acepta y no se predice nada.",
      },
      {
        letter: "B",
        text:
          "Se avisa (sin bloquear) de que ese rango incluye un día cerrado, con la explicación real, igual que ya hace el explorador de step 19 con sus días fuera de horizonte",
      },
    ],
    dependsOn: [],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 258,
  },
  {
    entryId: "J10",
    identifiers: ["J10"],
    order: 29,
    blockId: "bloque-9",
    question:
      "¿Los no presentados afectan a la lista de espera (p. ej. bajan de prioridad, o se filtran)?",
    currentBehaviour:
      "No: matchEntryAgainstSlot no mira nada del cliente; una inasistencia no cambia la compatibilidad de nadie con ningún hueco",
    options: [
      {
        letter: "A",
        text:
          "Nunca afecta: son dos sistemas sin relación, como hoy.",
      },
      {
        letter: "B",
        text:
          "Una inasistencia reciente se muestra (sin filtrar y sin ninguna penalización) junto al nombre en la lista de espera, como información para el operador.",
      },
      {
        letter: "C",
        text:
          "Tras varias inasistencias, la persona necesita confirmación extra para volver a apuntarse",
      },
    ],
    dependsOn: ["J5/K1"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 264,
  },
  {
    entryId: "K14",
    identifiers: ["K14"],
    order: 30,
    blockId: "bloque-9",
    question:
      "¿Debe Inicio enseñar una cifra de inasistencias (una tarjeta de KPI)?",
    currentBehaviour:
      "Una sola línea neutra, oculta cuando el número es cero; no hay ninguna tarjeta de KPI en Inicio",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: una línea neutra, nunca una tarjeta destacada.",
      },
      {
        letter: "B",
        text:
          "Se añade una tarjeta de KPI visible siempre, con su cifra.",
      },
      {
        letter: "C",
        text:
          "Se añade sólo si se supera cierto umbral (p. ej. más de N en el día)",
      },
    ],
    dependsOn: [],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 265,
  },
  {
    entryId: "K12",
    identifiers: ["K12"],
    order: 31,
    blockId: "bloque-9",
    question:
      "¿Puede el asistente de voz anotar inasistencias o reservar para grupos durante una llamada real?",
    currentBehaviour:
      "No: ninguna de las dos tiene ruta, campo en la conversación ni intención reconocida; ninguno de los diez desenlaces congelados del contrato de piloto tendría un resultado honesto para ninguna de las dos",
    notImplementedNote:
      "Ni ruta, ni campo de conversación, ni intención reconocida en el motor: no hay telefonía real y ninguno de los diez desenlaces congelados daría un resultado honesto.",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene fuera del asistente de voz: las dos siguen siendo exclusivas de la consola de operador.",
      },
      {
        letter: "B",
        text:
          "Se añade una de las dos al asistente de voz (exigiría acordar un desenlace nuevo del contrato de piloto, hoy congelado, con Demo Salon)",
      },
    ],
    dependsOn: ["J8", "J14"],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 266,
  },
  {
    entryId: "L1",
    identifiers: ["L1"],
    order: 32,
    blockId: "apendice-l",
    question:
      "¿Cuándo se da por cerrada una tarea humana que no tiene ninguna transición terminal? (cinco de los siete motivos: llamada escalada a una persona, reserva sintética huérfana, aviso de cambio de calendario, conflicto de conversión de lista de espera, motivo desconocido)",
    currentBehaviour:
      "Se queda abierta hasta el reinicio. No hay ningún botón «marcar como hecha», ningún endpoint genérico de cierre y ningún PATCH sobre una tarea: se cierra únicamente por la acción de dominio que de verdad la resuelve, y estos cinco motivos hoy no tienen ninguna",
    notImplementedNote:
      "No existe ningún botón «marcar como hecha», ninguna ruta de cierre genérico y ningún PATCH sobre una tarea.",
    options: [
      {
        letter: "A",
        text:
          "Se mantiene: sólo se cierra por una acción de dominio real; si un motivo no tiene ninguna, se queda abierta a propósito (obliga a construir esa acción antes de poder cerrarlo).",
      },
      {
        letter: "B",
        text:
          "Se añade, motivo a motivo, la acción de dominio que le falta (p. ej. \"contactado, sin más\" para el aviso de cambio de calendario) — trabajo real, no una casilla genérica.",
      },
      {
        letter: "C",
        text:
          "Se añade un cierre genérico \"marcar como hecha, sin más detalle\" para estos cinco motivos, aceptando que no cuenta la misma historia que un cierre por acción real",
      },
    ],
    dependsOn: [],
    externalDependencies: [],
    urgency: {
      kind: "puede_esperar",
      label:
        "PUEDE ESPERAR",
    },
    packLine: 278,
  },
];


// ---------------------------------------------------------------------
// Congelación en profundidad (I20-12): mutar el catálogo no es posible.
// ---------------------------------------------------------------------

export function congelarEnProfundidad<T>(valor: T): T {
  if (valor !== null && typeof valor === "object") {
    for (const hijo of Object.values(valor as Record<string, unknown>)) congelarEnProfundidad(hijo);
    Object.freeze(valor);
  }
  return valor;
}

// ---------------------------------------------------------------------
// Componentes fuertemente conexas — Tarjan (§2.9, D20-14). Sin dependencia
// nueva; 32 nodos, la recursión no corre ningún riesgo.
// ---------------------------------------------------------------------

/**
 * Devuelve las CFC NO TRIVIALES del grafo dirigido: las de más de un nodo y
 * las de un nodo con arista a sí mismo (una autodependencia es un ciclo).
 */
export function componentesNoTriviales(
  nodos: readonly string[],
  aristasDe: (nodo: string) => readonly string[],
): string[][] {
  let indiceSiguiente = 0;
  const indice = new Map<string, number>();
  const minimoAlcanzable = new Map<string, number>();
  const enPila = new Set<string>();
  const pila: string[] = [];
  const resultado: string[][] = [];

  function visitar(nodo: string): void {
    indice.set(nodo, indiceSiguiente);
    minimoAlcanzable.set(nodo, indiceSiguiente);
    indiceSiguiente += 1;
    pila.push(nodo);
    enPila.add(nodo);
    for (const destino of aristasDe(nodo)) {
      if (!indice.has(destino)) {
        visitar(destino);
        minimoAlcanzable.set(nodo, Math.min(minimoAlcanzable.get(nodo) as number, minimoAlcanzable.get(destino) as number));
      } else if (enPila.has(destino)) {
        minimoAlcanzable.set(nodo, Math.min(minimoAlcanzable.get(nodo) as number, indice.get(destino) as number));
      }
    }
    if (minimoAlcanzable.get(nodo) === indice.get(nodo)) {
      const componente: string[] = [];
      let sacado: string;
      do {
        sacado = pila.pop() as string;
        enPila.delete(sacado);
        componente.push(sacado);
      } while (sacado !== nodo);
      const tieneAutoArista = componente.length === 1 && aristasDe(nodo).includes(nodo);
      if (componente.length > 1 || tieneAutoArista) resultado.push(componente);
    }
  }

  for (const nodo of nodos) {
    if (!indice.has(nodo)) visitar(nodo);
  }
  return resultado;
}

/** Serialización canónica de un conjunto de identificadores, para comparar CFC como conjuntos. */
function claveDeConjunto(miembros: readonly string[]): string {
  return [...miembros].sort((a, b) => a.localeCompare(b, "es")).join(", ");
}

// ---------------------------------------------------------------------
// Validación (§2.9, D20-13): las ocho reglas V1–V8. Se ejecuta UNA vez al
// cargar el módulo (y lanza, matando el arranque si falla) y además se
// ejerce desde las pruebas con catálogos mutantes.
// ---------------------------------------------------------------------

function textoEnBlanco(texto: string): boolean {
  return texto.trim() === "";
}

export function validateDecisionCatalog(
  catalog: DecisionCatalog,
  componentesConocidas: readonly (readonly string[])[] = COMPONENTES_CONOCIDAS,
): void {
  const entradas = catalog.entries;
  const bloques = catalog.blocks;

  // V1 — entryId duplicado, o identificador repetido en dos entradas.
  const entryIdsVistos = new Set<string>();
  const identificadoresVistos = new Set<string>();
  for (const entrada of entradas) {
    if (entryIdsVistos.has(entrada.entryId)) throw new Error(`identificador duplicado: ${entrada.entryId}`);
    entryIdsVistos.add(entrada.entryId);
    for (const id of entrada.identifiers) {
      if (identificadoresVistos.has(id)) throw new Error(`identificador duplicado: ${id}`);
      identificadoresVistos.add(id);
    }
  }
  const bloquesVistos = new Set<string>();
  for (const bloque of bloques) {
    if (bloquesVistos.has(bloque.id)) throw new Error(`identificador duplicado: ${bloque.id}`);
    bloquesVistos.add(bloque.id);
  }

  // V2 — recuentos: 32 entradas, 33 identificadores, 32 J/K, 1 L, 6 entradas
  // bloqueantes, 7 identificadores bloqueantes; y los totales publicados
  // dicen exactamente eso (I20-2).
  const recuento = (nombre: string, esperado: number, encontrado: number): void => {
    if (esperado !== encontrado) {
      throw new Error(`recuento del catálogo: esperado ${String(esperado)} (${nombre}), encontrado ${String(encontrado)}`);
    }
  };
  const identificadores = entradas.flatMap((e) => e.identifiers);
  const jk = identificadores.filter((id) => id.startsWith("J") || id.startsWith("K"));
  const l = identificadores.filter((id) => id.startsWith("L"));
  const bloqueantes = entradas.filter((e) => e.urgency.kind === "bloquea");
  recuento("entradas", 32, entradas.length);
  recuento("identificadores", 33, identificadores.length);
  recuento("identificadores J/K", 32, jk.length);
  recuento("identificadores L", 1, l.length);
  recuento("entradas bloqueantes", 6, bloqueantes.length);
  recuento("identificadores bloqueantes", 7, bloqueantes.flatMap((e) => e.identifiers).length);
  recuento("totals.entries", catalog.totals.entries, entradas.length);
  recuento("totals.jkEntries", catalog.totals.jkEntries, entradas.filter((e) => e.identifiers.some((id) => !id.startsWith("L"))).length);
  recuento("totals.jkIdentifiers", catalog.totals.jkIdentifiers, jk.length);
  recuento("totals.lIdentifiers", catalog.totals.lIdentifiers, l.length);
  recuento("totals.blockingEntries", catalog.totals.blockingEntries, bloqueantes.length);
  recuento("totals.blockingIdentifiers", catalog.totals.blockingIdentifiers, bloqueantes.flatMap((e) => e.identifiers).length);

  // V3 — dependencia colgante.
  for (const entrada of entradas) {
    for (const dep of entrada.dependsOn) {
      if (!entryIdsVistos.has(dep)) throw new Error(`dependencia colgante: ${dep} en ${entrada.entryId}`);
    }
  }

  // V4 — (a) autodependencia, siempre prohibida; (b) toda CFC no trivial
  // debe coincidir EXACTAMENTE, como conjunto, con una declarada — y toda
  // declarada debe existir. En las dos direcciones (D20-14).
  for (const entrada of entradas) {
    if (entrada.dependsOn.includes(entrada.entryId)) {
      throw new Error(`componente fuertemente conexa no declarada: {${entrada.entryId}} — autodependencia`);
    }
  }
  const porId = new Map(entradas.map((e) => [e.entryId, e]));
  const cfc = componentesNoTriviales(
    entradas.map((e) => e.entryId),
    (nodo) => porId.get(nodo)?.dependsOn ?? [],
  );
  const declaradas = new Set(componentesConocidas.map(claveDeConjunto));
  for (const componente of cfc) {
    if (!declaradas.has(claveDeConjunto(componente))) {
      throw new Error(`componente fuertemente conexa no declarada: {${claveDeConjunto(componente)}}`);
    }
  }
  const calculadas = new Set(cfc.map(claveDeConjunto));
  for (const declarada of componentesConocidas) {
    if (!calculadas.has(claveDeConjunto(declarada))) {
      throw new Error(`componente declarada sin correspondencia en el grafo: {${claveDeConjunto(declarada)}}`);
    }
  }

  // V5 — opciones: 2 o 3, letras consecutivas desde «A», sin repetir.
  for (const entrada of entradas) {
    const letras = entrada.options.map((o) => o.letter).join("");
    if (entrada.options.length < 2 || entrada.options.length > 3 || (letras !== "AB" && letras !== "ABC")) {
      throw new Error(`opciones inválidas en ${entrada.entryId}`);
    }
  }

  // V6 — ningún campo de texto obligatorio en blanco.
  for (const entrada of entradas) {
    if (textoEnBlanco(entrada.question)) throw new Error(`texto en blanco en ${entrada.entryId} (question)`);
    if (textoEnBlanco(entrada.currentBehaviour)) throw new Error(`texto en blanco en ${entrada.entryId} (currentBehaviour)`);
    if (textoEnBlanco(entrada.urgency.label)) throw new Error(`texto en blanco en ${entrada.entryId} (urgency.label)`);
    for (const opcion of entrada.options) {
      if (textoEnBlanco(opcion.text)) throw new Error(`texto en blanco en ${entrada.entryId} (opción ${opcion.letter})`);
    }
  }
  for (const bloque of bloques) {
    if (textoEnBlanco(bloque.label)) throw new Error(`texto en blanco en ${bloque.id} (label)`);
  }

  // V7 — clasificación: kind cerrado y coherente con el prefijo literal.
  for (const entrada of entradas) {
    const { kind, label } = entrada.urgency;
    const valida =
      (kind === "bloquea" && label.startsWith("BLOQUEA — ")) ||
      (kind === "puede_esperar" && label.startsWith("PUEDE ESPERAR"));
    if (!valida) throw new Error(`clasificación desconocida en ${entrada.entryId}`);
  }

  // V8 — `order` permutación exacta de 1..32, coherente con
  // `facilitationOrder` (§2.7), y `blockId` existente.
  const ordenes = new Set(entradas.map((e) => e.order));
  if (ordenes.size !== 32 || Math.min(...ordenes) !== 1 || Math.max(...ordenes) !== 32) {
    throw new Error(`orden no determinista: order no es una permutación de 1..32`);
  }
  const bloquePorId = new Map(bloques.map((b) => [b.id, b]));
  for (const entrada of entradas) {
    if (!bloquePorId.has(entrada.blockId)) throw new Error(`orden no determinista: blockId inexistente ${entrada.blockId} en ${entrada.entryId}`);
  }
  const enOrden = [...entradas].sort((a, b) => a.order - b.order);
  // El apéndice (facilitationOrder null) va SIEMPRE detrás de los nueve bloques.
  const prioridad = (e: DecisionEntry): number => (bloquePorId.get(e.blockId) as DecisionBlock).facilitationOrder ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i < enOrden.length; i += 1) {
    const previa = enOrden[i - 1] as DecisionEntry;
    const actual = enOrden[i] as DecisionEntry;
    if (prioridad(previa) > prioridad(actual)) {
      throw new Error(`orden no determinista: ${actual.entryId} (facilitación ${String(prioridad(actual))}) va detrás de ${previa.entryId} (facilitación ${String(prioridad(previa))})`);
    }
  }
}

// ---------------------------------------------------------------------
// El catálogo, construido UNA vez, congelado y validado al cargar.
// ---------------------------------------------------------------------

export const DECISION_CATALOG: DecisionCatalog = congelarEnProfundidad({
  version: CATALOG_VERSION,
  sourceDocument: CATALOG_SOURCE_DOCUMENT,
  blocks: BLOQUES,
  entries: ENTRADAS,
  totals: {
    entries: 32,
    jkEntries: 31,
    jkIdentifiers: 32,
    lIdentifiers: 1,
    blockingEntries: 6,
    blockingIdentifiers: 7,
  } as const,
});

validateDecisionCatalog(DECISION_CATALOG);
