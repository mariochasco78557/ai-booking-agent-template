import type { EmployeeId, ServiceId } from "../callEngine/domain/types.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * LAS FORMAS COMPARTIDAS DE LA DEMOSTRACIÓN WEB DE RESERVAS (fase 1).
 *
 * Este módulo existe para que el fixture, el registro de locales, el almacén
 * y el servidor hablen del mismo vocabulario sin importarse en círculo.
 *
 * DÓNDE VIVEN LOS PRECIOS Y LAS DURACIONES: aquí y en `tenants.ts`, NUNCA en
 * `src/callEngine/**`. El motor de calendario no sabe —ni debe saber— cuánto
 * cuesta un servicio; sólo sabe cuántos minutos ocupa un intervalo cuando
 * alguien se los pasa. Esa separación es la que permite reutilizar el motor
 * tal cual, sin tocar ni una línea suya.
 *
 * EL PAGO ES UN ESTADO EN MEMORIA Y NADA MÁS. No hay pasarela, no hay
 * proveedor externo, no hay petición de red, no se pide ni se guarda ningún
 * dato financiero de nadie: ni número de tarjeta, ni cuenta bancaria, ni
 * identificador de cobro. `pagarAhora` sólo mueve un contador de céntimos de
 * «pendiente» a «pagado» dentro de este proceso. Un test estático
 * (`tests/bookingWeb/sinProveedorDePago.test.ts`) recorre todos los fuentes de
 * `src/bookingWeb/` y lo comprueba a nivel de texto, para que la promesa no
 * dependa de que nadie se despiste.
 * ────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------
// Vocabulario de pago sintético. Los nombres en snake_case son el CONTRATO
// con la fase 2 (la interfaz) y no se traducen ni se renombran.
// ---------------------------------------------------------------------

/** Lo que la persona elige al confirmar. Sólo dos valores, y ninguno pide un dato financiero. */
export type PaymentOption = "pay_now_demo" | "pay_at_salon";

/** En qué estado queda el cobro simulado. Uno por opción, sin estados intermedios. */
export type PaymentStatus = "demo_paid" | "pending_at_salon";

/**
 * El pago de una reserva. Los tres importes son ENTEROS de céntimos y cumplen
 * siempre `amount_paid_cents + amount_due_cents === amount_total_cents`, que es
 * la única aritmética de dinero de todo el módulo.
 */
export interface SyntheticPayment {
  payment_option: PaymentOption;
  payment_status: PaymentStatus;
  amount_total_cents: number;
  amount_paid_cents: number;
  amount_due_cents: number;
}

/**
 * Construye el pago sintético de una reserva. Función PURA: sin reloj, sin
 * azar, sin red. Es el único sitio donde se decide qué significa cada opción.
 */
export function buildSyntheticPayment(
  option: PaymentOption,
  amountTotalCents: number,
): SyntheticPayment {
  if (option === "pay_now_demo") {
    return {
      payment_option: "pay_now_demo",
      payment_status: "demo_paid",
      amount_total_cents: amountTotalCents,
      amount_paid_cents: amountTotalCents,
      amount_due_cents: 0,
    };
  }
  return {
    payment_option: "pay_at_salon",
    payment_status: "pending_at_salon",
    amount_total_cents: amountTotalCents,
    amount_paid_cents: 0,
    amount_due_cents: amountTotalCents,
  };
}

// ---------------------------------------------------------------------
// Catálogo y personas
// ---------------------------------------------------------------------

/**
 * Una línea del catálogo de un local. `durationMinutes` es lo que condiciona
 * el último inicio posible de cada tramo del día —no una constante escrita a
 * mano en ningún sitio—, porque se le pasa tal cual a `freeStartsForDuration`.
 */
export interface ServiceCatalogEntry {
  serviceId: ServiceId;
  label: string;
  durationMinutes: number;
  priceCents: number;
}

/**
 * Una persona sintética del local, con lo que sabe hacer. De aquí sale la
 * matriz de capacidades que consume el motor: una sola fuente de verdad.
 */
export interface DemoEmployee {
  employeeId: EmployeeId;
  displayName: string;
  serviceIds: readonly ServiceId[];
}

// ---------------------------------------------------------------------
// LA MARCA DEL LOCAL (contrato con la fase 2)
//
// La identidad visual de cada local es CONFIGURACIÓN, no plantilla: el
// envoltorio HTML es uno solo, el cliente `/app.js` es uno solo y la hoja de
// estilos es una sola. Lo único que cambia entre un local y otro son los
// valores de este bloque, declarados en `tenants.ts`. En la plantilla no hay
// —ni puede haber— un `if (tenantId === "…")`: la plantilla lee lo que diga
// aquí el local que se le pase.
// ---------------------------------------------------------------------

/**
 * Los activos de marca VERSIONADOS en el repositorio, por su nombre de fichero
 * y en una unión CERRADA.
 *
 * Que sea una unión de literales y no una `string` es la defensa: ninguna ruta
 * puede componer un camino de disco a partir de un texto arbitrario porque el
 * tipo no admite ningún texto que no esté escrito aquí, y `server.ts` traduce
 * cada uno de estos nombres a su ruta con un registro fijo, resuelto relativo
 * al módulo. Un local sólo puede declarar un activo que ya exista.
 */
export type BrandAssetFile = "demo-salon-logo.png";

/**
 * El identificador de PALETA del local. Cerrado a propósito: cada valor tiene
 * su bloque de variables `--txb-*` en `ui.css.ts` y no hay forma de pedir una
 * paleta que nadie haya definido. Viaja al documento en
 * `<body data-theme="…">`, que es el único conmutador de tema de la interfaz.
 */
export type TenantThemeId = "demo-salon" | "aralar";

/**
 * El distintivo de marca, en UNIÓN DISCRIMINADA: o un activo propio del local,
 * o un distintivo tipográfico (monograma + nombre) compuesto con texto real y
 * CSS. El segundo no necesita ningún fichero binario, es seleccionable, se
 * puede leer con un lector de pantalla y escala con el texto.
 */
export type TenantBrandLogo =
  | {
      kind: "asset";
      assetFile: BrandAssetFile;
      /** Texto alternativo de la imagen. Nunca vacío: la imagen ES la marca. */
      alt: string;
      width: number;
      height: number;
    }
  | {
      kind: "wordmark";
      /** El monograma (dos o tres letras). Decorativo: va con `aria-hidden`. */
      initials: string;
      /** El nombre escrito, que es lo que anuncia la marca a quien no ve el monograma. */
      text: string;
    };

/** Todo lo que el envoltorio HTML necesita saber de la identidad de un local. */
export interface TenantBrand {
  /** El `<title>` del documento. */
  title: string;
  /** El `<h1>` de la cabecera. */
  heading: string;
  /** El subtítulo bajo el `<h1>`. */
  tagline: string;
  theme: TenantThemeId;
  logo: TenantBrandLogo;
  /**
   * Las dos o tres letras con las que se compone el icono de pestaña
   * (`GET /brand/:tenantId/icon.svg`). Es un campo PROPIO y no se deduce del
   * distintivo: el logotipo de un local puede ser un activo binario sin
   * iniciales, y un icono generado a partir del `title` acabaría recortando el
   * nombre de otro local el día que dos empiecen igual.
   */
  monogram: string;
}

// ---------------------------------------------------------------------
// La reserva
// ---------------------------------------------------------------------

/**
 * Una reserva confirmada de la demostración. `status` tiene un solo valor a
 * propósito: la fase 1 no modela cancelaciones, y un tipo que no admite otra
 * cosa es mejor documentación que un comentario.
 */
export interface DemoBooking {
  id: string;
  tenantId: string;
  serviceId: ServiceId;
  employeeId: EmployeeId;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  status: "confirmed";
  payment: SyntheticPayment;
}

// ---------------------------------------------------------------------
// Textos obligatorios de la interfaz (contrato con la fase 2)
// ---------------------------------------------------------------------

/** El aviso que TODA pantalla de esta demostración tiene que mostrar. */
export const BOOKING_WEB_NOTICE = "Entorno de demostración · Datos ficticios";

/** Cómo se llama en pantalla cada estado de pago. Distintivos entre sí a propósito. */
export const PAYMENT_STATUS_LABELS: Readonly<Record<PaymentStatus, string>> = {
  demo_paid: "Pagada (demo)",
  pending_at_salon: "Pendiente en local",
};

/** Cómo se llama en pantalla cada opción antes de elegirla. */
export const PAYMENT_OPTION_LABELS: Readonly<Record<PaymentOption, string>> = {
  pay_now_demo: "Pagar ahora (demo)",
  pay_at_salon: "Pagar en el local",
};

/**
 * Los mensajes que devuelve la confirmación. Los dos caminos repiten «No se ha
 * realizado ningún cargo real» porque los dos son igual de ficticios: quien
 * elige «pagar ahora» tiene que leer, en la misma pantalla del éxito, que no le
 * han cobrado nada.
 */
export const PAYMENT_MESSAGES: Readonly<Record<PaymentOption, readonly string[]>> = {
  pay_now_demo: ["Pago simulado completado", "No se ha realizado ningún cargo real"],
  pay_at_salon: ["Reserva confirmada · Pendiente en local", "No se ha realizado ningún cargo real"],
};

// ---------------------------------------------------------------------
// LOS TRAMOS DE APERTURA DEL LOCAL (contrato con la fase 2)
//
// Un «tramo» es un intervalo en el que el local ABRE ese día. No se declara a
// mano en ningún sitio: lo calcula `server.ts` a partir de las ventanas que
// devuelve `resolveDayWindows` —el motor de calendario— para todas las
// personas del local, fusionadas. Aquí sólo viven los TEXTOS con los que se
// rotulan, por la misma razón que el vocabulario de pago: una sola fuente de
// verdad, y que el servidor y la interfaz no puedan llamar de dos maneras
// distintas a la misma cosa.
// ---------------------------------------------------------------------

/**
 * Un tramo de apertura ya rotulado, tal y como lo publica
 * `GET /api/:tenantId/availability` en su campo `windows`.
 *
 * `startMinutes`/`endMinutes` son los del HORARIO DE APERTURA, no los del
 * primer y último hueco libre: por eso el rótulo de un bloque no cambia
 * aunque queden dos huecos sueltos dentro del tramo.
 */
export interface OpeningWindow {
  /** Posición del tramo dentro del día, base 0 y en orden ascendente. */
  index: number;
  startMinutes: number;
  endMinutes: number;
  /** «Mañana», «Tarde», «Horario» o «Tramo N» — ver `openingWindowLabel`. */
  label: string;
  /** El rango de APERTURA del tramo, ya formateado: «09:00–14:00». */
  rangeLabel: string;
}

/**
 * Cómo se rotula el ÚNICO tramo de un día que abre de una sentada —el sábado
 * de la demostración, por ejemplo—. La interfaz usa esta misma palabra para su
 * «vista de día completo», que junta el día entero en un solo bloque.
 */
export const OPENING_WINDOW_SINGLE_LABEL = "Horario";

/**
 * Los dos tramos de un día PARTIDO, POR POSICIÓN Y NO POR RELOJ: el primero es
 * la mañana y el segundo la tarde porque están ordenados, no porque empiecen
 * antes o después de ninguna hora concreta.
 *
 * Ese matiz es justo el defecto que esta constante cierra. Con el pivote de
 * las 12:00 que había antes en la interfaz, una mañana cuyos primeros huecos
 * estuvieran ya reservados —primer inicio libre 12:30— se rotulaba «Tarde»,
 * cuando 12:30 pertenece al tramo de apertura de la mañana (09:00–14:00) y
 * ninguna reserva previa puede cambiar eso.
 */
export const OPENING_WINDOW_SPLIT_LABELS: readonly [string, string] = ["Mañana", "Tarde"];

/** Prefijo de los días con tres o más tramos: «Tramo 1», «Tramo 2»… */
export const OPENING_WINDOW_INDEXED_PREFIX = "Tramo";

/**
 * La etiqueta del tramo `index` (base 0) de un día que tiene `total` tramos.
 *
 * Deriva de la ESTRUCTURA del horario y de nada más: cuántas veces abre el
 * local ese día y en qué posición cae este tramo. No mira el reloj, así que no
 * hay ninguna hora de corte que puedan desmentir las reservas del día ni un
 * horario de temporada.
 */
export function openingWindowLabel(index: number, total: number): string {
  if (total <= 1) return OPENING_WINDOW_SINGLE_LABEL;
  const indexed = `${OPENING_WINDOW_INDEXED_PREFIX} ${String(index + 1)}`;
  if (total !== 2) return indexed;
  return OPENING_WINDOW_SPLIT_LABELS[index] ?? indexed;
}

// ---------------------------------------------------------------------
// LA WEB PÚBLICA (M-WEB-1) — SÓLO PRESENTACIÓN Y COPY.
//
// REGLA DE ORO DE ESTE BLOQUE: aquí no hay ni un precio, ni una duración, ni
// una hora, ni una lista de servicios por persona. Todo eso ya existe UNA vez
// —`ServiceCatalogEntry`, `DemoEmployee.serviceIds`, los `WeeklySchedule` de
// los fixtures— y escribirlo otra vez aquí sería crear una segunda verdad que
// nadie podría mantener sincronizada. Lo que hay aquí es lo único que el
// núcleo no sabe: cómo se cuenta el local.
// ---------------------------------------------------------------------

/**
 * Las secciones de la web pública. UNIÓN CERRADA: el vocabulario de secciones
 * lo posee la plantilla (el producto), no la configuración de un local. Un
 * local puede APAGAR una sección; no puede inventarse una.
 */
export type PublicSectionId =
  | "hero"
  | "servicios"
  | "profesionales"
  | "experiencia"
  | "reserva"
  | "info"
  | "faq";

/**
 * La sección de apertura, que se rotula con el `<h1>` del local y no con un
 * `<h2>` propio. Se escribe una vez, aquí, para que ni el modelo de los
 * rótulos ni el validador tengan que repetir el literal.
 */
export const HERO_SECTION = "hero" as const;

/**
 * Las secciones que llevan un `<h2>` propio: TODAS menos la de apertura. Un
 * `Exclude` y no una lista escrita a mano: el día que se añada una sección al
 * vocabulario, entra sola aquí y el `Record` de rótulos deja de compilar hasta
 * que alguien le escriba el suyo.
 */
export type HeadedSectionId = Exclude<PublicSectionId, typeof HERO_SECTION>;

/**
 * La sección que NO se puede apagar. El asistente de reserva es el producto:
 * si la configuración pudiera quitarlo, un local sería una web distinta y no
 * la misma web con otra piel.
 */
export const ALWAYS_ON_SECTION = "reserva" as const;

/** Las secciones que un local sí puede apagar. */
export type OptionalSectionId = Exclude<PublicSectionId, typeof ALWAYS_ON_SECTION>;

/**
 * El interruptor por sección. Es un `Record` EXHAUSTIVO a propósito: aquí los
 * tipos sí son el mecanismo correcto, porque las claves las posee la plantilla
 * y son las mismas para todo local. Un local nuevo que olvide una sección no
 * compila. `reserva` no está entre las claves: no hay dónde escribir que se
 * apaga.
 */
export type EnabledSections = Readonly<Record<OptionalSectionId, boolean>>;

/**
 * EL ORDEN DE LA PÁGINA, IGUAL PARA TODOS LOS LOCALES Y NO CONFIGURABLE.
 *
 * Que el orden fuese configurable permitiría a un local convertirse en otra
 * web sin tocar código: eso es un fork por la puerta de atrás. Lo único que la
 * configuración decide es QUÉ se muestra, nunca EN QUÉ ORDEN. El recorrido
 * vende antes de pedir: la reserva llega después de contar el oficio.
 */
export const PUBLIC_SECTION_ORDER: readonly PublicSectionId[] = [
  "hero",
  "servicios",
  "profesionales",
  "experiencia",
  "reserva",
  "info",
  "faq",
];

/**
 * El id de DOM de cada sección, con los nombres ESCRITOS ENTEROS —mismo patrón
 * que el registro de activos de marca—, para que ningún ancla se componga
 * concatenando trozos. Un ancla compuesta es un ancla que puede apuntar a algo
 * que no existe sin que nadie se entere hasta que un humano la pulsa.
 */
export const PUBLIC_SECTION_DOM_IDS: Readonly<Record<PublicSectionId, string>> = {
  hero: "txb-seccion-hero",
  servicios: "txb-seccion-servicios",
  profesionales: "txb-seccion-profesionales",
  experiencia: "txb-seccion-experiencia",
  reserva: "txb-seccion-reserva",
  info: "txb-seccion-info",
  faq: "txb-seccion-faq",
};

/**
 * Las secciones con rótulo, EN EL ORDEN DE LA PÁGINA y derivadas de él. No es
 * una segunda lista: es `PUBLIC_SECTION_ORDER` sin la apertura, así que no
 * puede desincronizarse del orden ni olvidarse de una sección nueva.
 */
export const HEADED_SECTION_IDS: readonly HeadedSectionId[] = PUBLIC_SECTION_ORDER.filter(
  (id): id is HeadedSectionId => id !== HERO_SECTION,
);

/**
 * CÓMO SE ROTULA CADA SECCIÓN EN ESTE LOCAL.
 *
 * Vive en la configuración y no en la plantilla porque un rótulo es VOZ, no
 * estructura: cuando eran constantes compartidas, el menú de un local decía
 * «Qué hacemos» y el `<h2>` de esa misma sección decía «Servicios» — dos
 * nombres para la misma cosa en la misma pantalla, y el segundo local acababa
 * siendo el primero repintado. El validador ata cada rótulo a la etiqueta del
 * menú que apunta a esa sección, así que esa divergencia ya no puede volver.
 *
 * `Record` EXHAUSTIVO a propósito, y sin la apertura: el `hero` se rotula con
 * el `<h1>` del local, que ya existe. Una sección nueva sin rótulo no compila.
 */
export type SectionHeadings = Readonly<Record<HeadedSectionId, string>>;

/**
 * EL EMBLEMA DEL HERO, en unión CERRADA y por la misma razón que
 * `BrandAssetFile`: cada valor tiene su dibujo escrito en línea en
 * `ui.sections.ts` y no hay forma de pedir uno que nadie haya dibujado. No es
 * un fichero ni una ruta —no se puede componer un camino de disco con él—, y
 * no llega nunca al documento como texto: sólo indexa una tabla.
 *
 * Que sea un campo del local, y no una constante compartida, es lo que impide
 * que dos locales se presenten con el mismo dibujo en la primera pantalla.
 */
export type HeroEmblemId = "tijeras-cruzadas" | "rombos-concentricos";

/**
 * Si esa sección se pinta para este local. La rama es sobre la IDENTIDAD DE LA
 * SECCIÓN, jamás sobre el local: `flags` ya es del local resuelto, así que
 * ningún `if (tenantId === "…")` puede colarse por aquí.
 */
export function isSectionEnabled(flags: EnabledSections, id: PublicSectionId): boolean {
  return id === ALWAYS_ON_SECTION ? true : flags[id];
}

/** Lo que va en `<meta name="description">`. Un solo campo: esto no es un gestor de contenidos. */
export interface PublicSeo {
  description: string;
}

/**
 * El bloque de apertura. `primaryCtaLabel` y `secondaryCtaLabel` son
 * ETIQUETAS, no destinos: el destino lo fija la plantilla con
 * `PUBLIC_SECTION_DOM_IDS`, así que un local no puede apuntar un botón fuera
 * del documento ni a ninguna parte.
 */
export interface PublicHero {
  /** Línea corta sobre el titular. */
  eyebrow: string;
  headline: string;
  subheadline: string;
  primaryCtaLabel: string;
  secondaryCtaLabel: string;
  /** Dos a cuatro frases cortas. SIN precio, SIN duración y SIN hora: lo exige el validador. */
  highlights: readonly string[];
}

/**
 * Un enlace de la navegación. `target` es una SECCIÓN, no una URL: no existe
 * ningún campo donde escribir un `href`, así que la navegación no puede salir
 * del documento ni apuntar a un origen ajeno (que además la CSP bloquearía).
 */
export interface PublicNavLink {
  target: PublicSectionId;
  label: string;
}

export interface PublicNav {
  links: readonly PublicNavLink[];
  /** Etiqueta del botón de acción de la barra. Su destino es siempre `ALWAYS_ON_SECTION`. */
  ctaLabel: string;
}

/**
 * CÓMO SE CUENTA UN SERVICIO. Se asocia al catálogo por `serviceId` y no trae
 * ni `label`, ni `priceCents`, ni `durationMinutes`: los tres viven en
 * `ServiceCatalogEntry` y aquí no hay dónde escribirlos.
 */
export interface ServicePresentation {
  serviceId: ServiceId;
  /** Rótulo editorial («Barbería», «Corte»). Es un distintivo: NADIE agrupa por él. */
  category: string;
  description: string;
  /** Si se destaca visualmente. Es peso visual, no precio ni popularidad. */
  featured: boolean;
}

/**
 * CÓMO SE PRESENTA UNA PERSONA. Se asocia por `employeeId` y NO lleva lista de
 * servicios: la compatibilidad vive en `DemoEmployee.serviceIds` y llega a la
 * pantalla DERIVADA (`PublicProfessionalView.servicesLabel`). Tampoco lleva
 * nombre (está en `DemoEmployee.displayName`), ni horario (está en el
 * calendario), ni fotografía (no hay activo por persona, y no se le pone cara
 * a alguien que no existe).
 */
export interface ProfessionalProfile {
  employeeId: EmployeeId;
  /** «Estilista sénior», «Barbero». Editorial. */
  role: string;
  bio: string;
  /**
   * Especialidades EDITORIALES. No pueden coincidir con una etiqueta del
   * catálogo: repetir «Corte de pelo» aquí crearía una segunda declaración de
   * lo que esa persona hace, capaz de contradecir a la matriz de capacidades
   * el día que `serviceIds` cambie. El validador lo rechaza.
   */
  specialties: readonly string[];
  /** Monograma decorativo (`aria-hidden`), dos o tres letras. Sustituye a la fotografía. */
  initials: string;
}

/**
 * Un paso de la narración de la experiencia. NO tiene `order`: la posición es
 * la del array, y un campo que repitiera el índice sería una segunda fuente de
 * algo que ya es evidente. Tampoco es el asistente de reserva: eso son los
 * cuatro pasos de `txb-steps`, que no se tocan.
 */
export interface ExperienceStep {
  title: string;
  description: string;
}

/**
 * Las CLASES de dato práctico, CERRADAS. No existe «otro», y no existe
 * «horario»: los horarios pertenecen al calendario y llegan a la pantalla en
 * `TenantPublicView.week`, derivados del motor. Tampoco existe teléfono ni
 * correo: esta demostración no publica un contacto que sonaría en algún sitio.
 *
 * `address` existe para poder activarse por configuración el día que haya
 * datos autorizados, y HOY NINGÚN LOCAL DECLARA UNO. Un item ausente no se
 * pinta: cero marcadores de posición con una dirección inventada.
 */
export type PracticalInfoKind =
  | "address"
  | "access"
  | "payment"
  | "policy"
  | "accessibility";

export interface PracticalInfoItem {
  kind: PracticalInfoKind;
  label: string;
  value: string;
}

export interface PracticalInfo {
  items: readonly PracticalInfoItem[];
  /** Nota al pie de la sección. */
  note: string;
}

export interface FaqEntry {
  question: string;
  answer: string;
}

/**
 * TODO EL CONTENIDO PÚBLICO DE UN LOCAL, en un solo bloque declarado en
 * `content/<local>.content.ts` y validado al construir el registro.
 *
 * NO tiene `theme`: el tema ya vive en `TenantBrand.theme`, y declararlo dos
 * veces permitiría que el envoltorio y las secciones se contradijeran.
 */
export interface TenantPublicContent {
  seo: PublicSeo;
  /**
   * La franja superior de la página. Es DISTINTA del literal contractual
   * `BOOKING_WEB_NOTICE` —que aparece exactamente una vez, en el pie— y tiene
   * la voz del local, pero el validador la obliga a decir «demostración»: esa
   * palabra es la garantía de que la primera línea del documento delata lo que
   * la página es, sin depender de que nadie llegue al pie.
   */
  demoBanner: string;
  hero: PublicHero;
  /**
   * El dibujo que abre la página. Sólo el identificador: el SVG lo posee la
   * plantilla, que es quien sabe qué es marcado seguro y qué no.
   */
  heroEmblem: HeroEmblemId;
  nav: PublicNav;
  /**
   * Cómo se rotula cada sección EN ESTE LOCAL. El validador exige que cada
   * etiqueta del menú coincida palabra por palabra con el rótulo de la sección
   * a la que apunta: el menú y el titular son el mismo texto, no dos.
   */
  sectionHeadings: SectionHeadings;
  /** Uno por CADA servicio del catálogo de este local, ni uno más. */
  servicePresentation: readonly ServicePresentation[];
  /** Uno por CADA persona de este local, ni una más. */
  professionalProfiles: readonly ProfessionalProfile[];
  experienceSteps: readonly ExperienceStep[];
  practicalInfo: PracticalInfo;
  faq: readonly FaqEntry[];
  enabledSections: EnabledSections;
  /** Texto del pie, propio del local. El aviso contractual va aparte y es constante. */
  footerTagline: string;
  /** Declaración de que las personas y los datos son sintéticos, con la voz del local. */
  syntheticDisclosure: string;
}

// ---------------------------------------------------------------------
// LAS VISTAS: lo ÚNICO que la plantilla llega a ver.
// ---------------------------------------------------------------------

/**
 * Un servicio, listo para pintar. El dinero y el tiempo viajan YA FORMATEADOS:
 * no hay `priceCents` ni `durationMinutes`, así que la plantilla no puede
 * dividir por cien, ni redondear, ni inventarse un segundo formato — sólo
 * imprimir lo que `formatEuros`/`formatDurationLabel` produjeron.
 */
export interface PublicServiceView {
  serviceId: ServiceId;
  /** De `ServiceCatalogEntry.label`, que sale de `SERVICE_LABELS` del dominio. */
  label: string;
  /** `formatEuros(priceCents)` — el MISMO formateador que alimenta `/bootstrap`. */
  priceLabel: string;
  durationLabel: string;
  category: string;
  description: string;
  featured: boolean;
}

/** Una persona, lista para pintar. Lo que sabe hacer llega DERIVADO, nunca declarado. */
export interface PublicProfessionalView {
  employeeId: EmployeeId;
  /** De `DemoEmployee.displayName`. */
  displayName: string;
  role: string;
  bio: string;
  specialties: readonly string[];
  initials: string;
  /** «Barba · Corte de pelo · Corte y barba»: DERIVADO de `DemoEmployee.serviceIds`. */
  servicesLabel: string;
  /**
   * Los ids que esta persona SÍ hace, derivados de la misma matriz. Viajan
   * aparte del rótulo porque el cliente los necesita como DATO —para apagar el
   * botón de quien no puede hacer el servicio ya elegido— y un rótulo con
   * puntos medios no se puede comparar sin volver a partirlo.
   */
  serviceIds: readonly ServiceId[];
}

/**
 * Un día del horario de apertura, tal y como se muestra en la sección de
 * información práctica. `windows` sale ENTERO de `openingWindowsFor`, que a su
 * vez sale de `resolveDayWindows`. Aquí no se resta ni un minuto.
 */
export interface OpeningDayView {
  date: string;
  weekdayLabel: string;
  windows: readonly OpeningWindow[];
  /** `windows.length > 0`. Un día sin tramos es un día cerrado, y lo dice el motor. */
  open: boolean;
}

/**
 * LO ÚNICO QUE VE LA PLANTILLA PÚBLICA.
 *
 * NO es asignable desde `TenantDefinition` (a diferencia de `TenantBrandView`,
 * que es un `Pick`), así que sólo puede producirla `buildTenantPublicView`.
 * Ese estrechamiento no es cosmético: es lo que impide que alguien escriba
 * `renderBookingHtml(tenant)` y meta el calendario entero en la plantilla.
 *
 * Y no contiene: `priceCents`, `durationMinutes`, `calendar`, `employees` ni
 * `services` crudos, `demoToday`, ni el almacén. Todo el dinero y todo el
 * tiempo que hay aquí son cadenas ya formateadas por una única función.
 */
export interface TenantPublicView {
  tenantId: string;
  brand: TenantBrand;
  seo: PublicSeo;
  demoBanner: string;
  hero: PublicHero;
  /** El identificador del dibujo del hero; la plantilla lo traduce a su SVG. */
  heroEmblem: HeroEmblemId;
  nav: PublicNav;
  /** El rótulo de cada sección con `<h2>`, ya del local. */
  sectionHeadings: SectionHeadings;
  services: readonly PublicServiceView[];
  professionals: readonly PublicProfessionalView[];
  experience: readonly ExperienceStep[];
  practicalInfo: PracticalInfo;
  week: readonly OpeningDayView[];
  faq: readonly FaqEntry[];
  enabledSections: EnabledSections;
  footerTagline: string;
  syntheticDisclosure: string;
  /** Siempre `BOOKING_WEB_NOTICE`. Viaja en la vista para que el pie no lo reescriba. */
  notice: string;
}

// ---------------------------------------------------------------------
// Rótulos y formateadores ÚNICOS
// ---------------------------------------------------------------------

/** Cuántos días cubre el horario publicado: una semana natural completa. */
export const PUBLIC_WEEK_DAYS = 7;

/** Cómo se rotula un día sin ningún tramo de apertura. */
export const OPENING_CLOSED_LABEL = "Cerrado";

const WEEKDAY_LABELS: readonly [string, string, string, string, string, string, string] = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];

/**
 * El nombre del día por el índice 0..6 que devuelve `dayOfWeek` del motor.
 *
 * El índice empieza en domingo porque así lo devuelve el motor, no porque la
 * semana se pinte así: la semana publicada arranca en lunes y ese giro lo hace
 * `openingWeekFor`, en un solo sitio. Un índice fuera de rango LANZA en vez de
 * devolver un hueco, porque un día sin nombre en el horario es un fallo de
 * programación, no un dato que se pueda maquillar.
 */
export function weekdayLabel(dayOfWeekIndex: number): string {
  const label = WEEKDAY_LABELS[dayOfWeekIndex];
  if (label === undefined) {
    throw new Error(`Día de la semana fuera de rango: ${String(dayOfWeekIndex)}`);
  }
  return label;
}

/**
 * Céntimos enteros a texto con dos decimales y símbolo, sin depender de ICU ni
 * de la configuración regional del equipo.
 *
 * VIVE AQUÍ, y no en `server.ts` que la re-exporta, para que la vista pública
 * pueda usar EXACTAMENTE la misma que `/bootstrap` sin importar el servidor.
 * Dos formateadores de dinero son dos precios el día que uno redondee distinto.
 */
export function formatEuros(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${String(Math.floor(abs / 100))},${String(abs % 100).padStart(2, "0")} €`;
}

/**
 * El ÚNICO sitio donde una duración del catálogo se convierte en texto. Que
 * sea uno solo es lo que impide que la portada diga «1 h» donde el asistente
 * dice «60 min» para el mismo servicio.
 */
export function formatDurationLabel(durationMinutes: number): string {
  if (durationMinutes < 60) return `${String(durationMinutes)} min`;
  const hours = Math.floor(durationMinutes / 60);
  const rest = durationMinutes % 60;
  if (rest === 0) return `${String(hours)} h`;
  return `${String(hours)} h ${String(rest)} min`;
}
