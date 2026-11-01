import { SERVICE_LABELS } from "../../callEngine/domain/types.js";
import {
  ALWAYS_ON_SECTION,
  BOOKING_WEB_NOTICE,
  HEADED_SECTION_IDS,
  HERO_SECTION,
  isSectionEnabled,
  PUBLIC_SECTION_DOM_IDS,
  PUBLIC_SECTION_ORDER,
  type DemoEmployee,
  type PublicSectionId,
  type ServiceCatalogEntry,
  type TenantPublicContent,
} from "../model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * LA PUERTA DEL CONTENIDO PÚBLICO. Se cruza UNA vez, al construir el registro,
 * y revienta ruidosamente: la misma postura que la carga de activos de marca, y
 * por el mismo motivo — un local mal declarado tiene que morir antes de que
 * exista una ruta, no pintar una ficha vacía en la pestaña de un navegador.
 *
 * Como `buildTenantRegistry()` lo llama todo el mundo, un desajuste pone en
 * rojo la suite entera y no una prueba dedicada que alguien pueda borrar.
 *
 * QUÉ DEFIENDE, EN UNA FRASE CADA COSA:
 *
 * - Que el copy no reescriba el dominio. El precio vive en el catálogo, la
 *   duración en el catálogo y el horario en el calendario; un texto que los
 *   repita será verdad hasta la primera temporada y mentira después.
 * - Que el copy no publique datos de una persona real ni saque a nadie del
 *   documento: ni correos, ni teléfonos, ni enlaces a otro sitio.
 * - Que la franja superior delate siempre que esto es una demostración.
 * - Que servicios y personas del núcleo tengan su presentación, y sólo la suya:
 *   la biyección se comprueba en las DOS direcciones y nombra al culpable.
 * - Que el local no se llame a sí mismo de dos maneras: el rótulo de una
 *   sección y la etiqueta del menú que apunta a ella son el MISMO texto.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * Dinero escrito a mano en el copy. El precio vive en el catálogo.
 *
 * El límite de palabra va DENTRO de las alternativas con letras y no al final
 * de todo: `€` no es un carácter de palabra, así que un `\b` detrás de él no
 * casa nunca y «desde 12 €» —la forma más natural en castellano, y justo la
 * que produce `formatEuros`— se colaba entera.
 */
const DINERO = /\d[\d.,]*\s*(?:€|eur\b|euros?\b)/i;

/** Duraciones escritas a mano. La duración vive en el catálogo. */
const DURACION = /\b\d+\s*(?:min|mins|minutos?|h|horas?)\b/i;

/** Horas de reloj escritas a mano. El horario vive en el calendario. */
const RELOJ = /\b\d{1,2}[:.]\d{2}\b/;

/**
 * Un correo, un enlace o cualquier forma de salir del documento. La navegación
 * de esta web se declara por SECCIÓN y no por URL (ver `PublicNavLink`), así
 * que un enlace escrito dentro de un texto sería la única puerta hacia fuera
 * que queda, y la CSP la bloquearía después de haberla enseñado.
 */
const CONTACTO_O_ENLACE = /@|https?:|www\./i;

/**
 * Una tirada de teléfono. Las personas de esta demostración son sintéticas y
 * el local no publica un número que sonaría en algún sitio; un número aquí
 * sería, en el mejor de los casos, el de alguien que no ha dado permiso.
 */
const TELEFONO = /\+?\d[\d ().-]{7,}\d/;

/** La palabra que la franja superior está obligada a decir, ya normalizada. */
const PALABRA_DEMOSTRACION = "demostracion";

/** Sin acentos, sin mayúsculas y sin espacios de sobra: para comparar, nunca para mostrar. */
function normaliza(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * El error propio del contenido. Es una clase y no un `Error` pelado para que
 * una prueba pueda exigir ESTE fallo y no cualquier excepción que pase por
 * allí, que es como una prueba de validación acaba pasando por el motivo
 * equivocado.
 */
export class TenantContentError extends Error {}

function romper(tenantId: string, detalle: string): never {
  throw new TenantContentError(
    `Contenido público inválido en el local «${tenantId}»: ${detalle}. ` +
      `La demostración no arranca con una configuración incoherente a propósito.`,
  );
}

function exigeTexto(tenantId: string, campo: string, valor: string): void {
  if (valor.trim() === "") romper(tenantId, `«${campo}» está vacío`);
}

/**
 * NINGÚN texto de copy puede repetir un precio, una duración ni una hora, ni
 * publicar un contacto o un enlace. Se aplica a TODOS los campos de texto, sin
 * excepciones cómodas: una etiqueta de botón es tan pública como un titular.
 */
function exigeCopyLimpio(tenantId: string, campo: string, valor: string): void {
  exigeTexto(tenantId, campo, valor);
  if (DINERO.test(valor)) {
    romper(tenantId, `«${campo}» escribe un importe («${valor}»); el precio vive en el catálogo`);
  }
  if (DURACION.test(valor)) {
    romper(tenantId, `«${campo}» escribe una duración («${valor}»); la duración vive en el catálogo`);
  }
  if (RELOJ.test(valor)) {
    romper(tenantId, `«${campo}» escribe una hora («${valor}»); el horario vive en el calendario`);
  }
  if (CONTACTO_O_ENLACE.test(valor)) {
    romper(
      tenantId,
      `«${campo}» escribe un correo o un enlace («${valor}»); esta web no sale de su propio documento`,
    );
  }
  if (TELEFONO.test(valor)) {
    romper(
      tenantId,
      `«${campo}» escribe algo que parece un teléfono («${valor}»); aquí no se publica el dato de nadie`,
    );
  }
}

/**
 * Lo que hace falta para juzgar el contenido de UN local: su copy y las dos
 * listas del núcleo con las que tiene que casar. No recibe la definición
 * entera a propósito — con el calendario delante, alguien acabaría validando
 * el copy contra la disponibilidad del día, que cambia con cada reserva.
 */
export interface TenantContentInput {
  tenantId: string;
  services: readonly ServiceCatalogEntry[];
  employees: readonly DemoEmployee[];
  content: TenantPublicContent;
}

export function assertTenantContentIsComplete(input: TenantContentInput): void {
  const { tenantId, services, employees, content } = input;

  // ── 0. La tabla de secciones es coherente consigo misma ────────────────
  const declaradas = Object.keys(PUBLIC_SECTION_DOM_IDS) as PublicSectionId[];
  for (const id of declaradas) {
    if (PUBLIC_SECTION_ORDER.filter((s) => s === id).length !== 1) {
      romper(
        tenantId,
        `la sección «${id}» no aparece exactamente una vez en PUBLIC_SECTION_ORDER`,
      );
    }
  }
  if (PUBLIC_SECTION_ORDER.length !== declaradas.length) {
    romper(
      tenantId,
      "PUBLIC_SECTION_ORDER y PUBLIC_SECTION_DOM_IDS no cubren las mismas secciones",
    );
  }

  // ── 1. BIYECCIÓN servicios ↔ presentación, en las DOS direcciones ──────
  const idsCatalogo = services.map((s) => s.serviceId);
  const idsPresentacion = content.servicePresentation.map((p) => p.serviceId);

  if (new Set(idsPresentacion).size !== idsPresentacion.length) {
    romper(tenantId, "hay dos presentaciones para el mismo serviceId");
  }
  for (const serviceId of idsCatalogo) {
    if (!idsPresentacion.includes(serviceId)) {
      romper(
        tenantId,
        `el servicio ${String(serviceId)} está en el catálogo y no tiene presentación`,
      );
    }
  }
  for (const serviceId of idsPresentacion) {
    if (!idsCatalogo.includes(serviceId)) {
      romper(
        tenantId,
        `hay presentación para el servicio ${String(serviceId)}, que no está en su catálogo`,
      );
    }
  }

  // ── 2. BIYECCIÓN personas ↔ fichas, en las DOS direcciones ─────────────
  const idsPersonas = employees.map((e) => e.employeeId);
  const idsFichas = content.professionalProfiles.map((p) => p.employeeId);

  if (new Set(idsFichas).size !== idsFichas.length) {
    romper(tenantId, "hay dos fichas para el mismo employeeId");
  }
  for (const employeeId of idsPersonas) {
    if (!idsFichas.includes(employeeId)) {
      romper(tenantId, `la persona ${String(employeeId)} trabaja aquí y no tiene ficha`);
    }
  }
  for (const employeeId of idsFichas) {
    if (!idsPersonas.includes(employeeId)) {
      romper(
        tenantId,
        `hay ficha de la persona ${String(employeeId)}, que no trabaja en este local`,
      );
    }
  }

  // ── 3. Las fichas no reescriben el catálogo ────────────────────────────
  const etiquetasDeServicio = new Set([
    ...services.map((s) => normaliza(s.label)),
    ...Object.values(SERVICE_LABELS).map((l) => normaliza(l)),
  ]);
  for (const ficha of content.professionalProfiles) {
    const quien = `professionalProfiles[${String(ficha.employeeId)}]`;
    exigeCopyLimpio(tenantId, `${quien}.role`, ficha.role);
    exigeCopyLimpio(tenantId, `${quien}.bio`, ficha.bio);
    const monograma = ficha.initials.trim();
    if (monograma.length < 2 || monograma.length > 3) {
      romper(
        tenantId,
        `el monograma de la persona ${String(ficha.employeeId)} debe tener dos o tres letras`,
      );
    }
    for (const [i, especialidad] of ficha.specialties.entries()) {
      exigeCopyLimpio(tenantId, `${quien}.specialties[${String(i)}]`, especialidad);
      if (etiquetasDeServicio.has(normaliza(especialidad))) {
        romper(
          tenantId,
          `la especialidad «${especialidad}» de ${quien} repite una etiqueta del catálogo; ` +
            `qué hace cada persona ya lo dice DemoEmployee.serviceIds y llega derivado a la pantalla`,
        );
      }
    }
  }

  // ── 4. La franja superior delata la demostración ───────────────────────
  exigeCopyLimpio(tenantId, "demoBanner", content.demoBanner);
  if (normaliza(content.demoBanner) === normaliza(BOOKING_WEB_NOTICE)) {
    romper(
      tenantId,
      "«demoBanner» repite palabra por palabra el aviso contractual del pie; la franja superior " +
        "habla con la voz del local y el aviso aparece una sola vez",
    );
  }
  if (!normaliza(content.demoBanner).includes(PALABRA_DEMOSTRACION)) {
    romper(
      tenantId,
      "«demoBanner» no dice «demostración»; esa palabra en la primera línea del documento es lo " +
        "que impide que alguien tome esta página por la web real de una peluquería",
    );
  }

  // ── 5. El copy no duplica dominio ni publica un dato de nadie ──────────
  exigeCopyLimpio(tenantId, "seo.description", content.seo.description);
  exigeCopyLimpio(tenantId, "hero.eyebrow", content.hero.eyebrow);
  exigeCopyLimpio(tenantId, "hero.headline", content.hero.headline);
  exigeCopyLimpio(tenantId, "hero.subheadline", content.hero.subheadline);
  exigeCopyLimpio(tenantId, "hero.primaryCtaLabel", content.hero.primaryCtaLabel);
  exigeCopyLimpio(tenantId, "hero.secondaryCtaLabel", content.hero.secondaryCtaLabel);
  if (content.hero.highlights.length < 2 || content.hero.highlights.length > 4) {
    romper(tenantId, "hero.highlights debe tener entre dos y cuatro frases");
  }
  for (const [i, frase] of content.hero.highlights.entries()) {
    exigeCopyLimpio(tenantId, `hero.highlights[${String(i)}]`, frase);
  }
  for (const p of content.servicePresentation) {
    const cual = `servicePresentation[${String(p.serviceId)}]`;
    exigeCopyLimpio(tenantId, `${cual}.category`, p.category);
    exigeCopyLimpio(tenantId, `${cual}.description`, p.description);
  }
  for (const [i, paso] of content.experienceSteps.entries()) {
    exigeCopyLimpio(tenantId, `experienceSteps[${String(i)}].title`, paso.title);
    exigeCopyLimpio(tenantId, `experienceSteps[${String(i)}].description`, paso.description);
  }
  for (const [i, item] of content.practicalInfo.items.entries()) {
    exigeCopyLimpio(tenantId, `practicalInfo.items[${String(i)}].label`, item.label);
    exigeCopyLimpio(tenantId, `practicalInfo.items[${String(i)}].value`, item.value);
  }
  exigeCopyLimpio(tenantId, "practicalInfo.note", content.practicalInfo.note);
  for (const [i, entrada] of content.faq.entries()) {
    exigeCopyLimpio(tenantId, `faq[${String(i)}].question`, entrada.question);
    exigeCopyLimpio(tenantId, `faq[${String(i)}].answer`, entrada.answer);
  }
  exigeCopyLimpio(tenantId, "footerTagline", content.footerTagline);
  exigeCopyLimpio(tenantId, "syntheticDisclosure", content.syntheticDisclosure);

  // ── 6. La navegación no queda coja ni apunta a lo apagado ──────────────
  if (content.nav.links.length === 0) romper(tenantId, "la navegación no tiene ningún enlace");
  exigeCopyLimpio(tenantId, "nav.ctaLabel", content.nav.ctaLabel);
  const vistos = new Set<PublicSectionId>();
  for (const enlace of content.nav.links) {
    exigeCopyLimpio(tenantId, `nav.links[${enlace.target}].label`, enlace.label);
    if (vistos.has(enlace.target)) {
      romper(tenantId, `la navegación repite la sección «${enlace.target}»`);
    }
    vistos.add(enlace.target);
    if (!isSectionEnabled(content.enabledSections, enlace.target)) {
      romper(tenantId, `la navegación enlaza «${enlace.target}», que este local tiene apagada`);
    }
  }

  // ── 6.bis. EL MENÚ Y EL TITULAR DE UNA SECCIÓN SON EL MISMO TEXTO ──────
  //
  // Los rótulos son copy como cualquier otro —no vacíos, sin importes, sin
  // duraciones, sin horas, sin contactos ni enlaces—, y además están ATADOS a
  // la navegación. Sin esta atadura, un local podía anunciar «Qué hacemos» en
  // el menú y titular «Servicios» esa misma sección: dos nombres para la misma
  // cosa en la misma pantalla, que es exactamente lo que hacía que un local
  // pareciera el otro repintado con la voz a medias.
  //
  // La apertura queda fuera porque no tiene rótulo propio: se rotula con el
  // `<h1>` del local, que ya dice su nombre.
  for (const seccion of HEADED_SECTION_IDS) {
    exigeCopyLimpio(tenantId, `sectionHeadings.${seccion}`, content.sectionHeadings[seccion]);
  }
  for (const enlace of content.nav.links) {
    if (enlace.target === HERO_SECTION) continue;
    const rotulo = content.sectionHeadings[enlace.target];
    if (enlace.label !== rotulo) {
      romper(
        tenantId,
        `la navegación llama «${enlace.label}» a la sección «${enlace.target}», cuyo rótulo es ` +
          `«${rotulo}»; el menú y el titular de una sección son el mismo texto, no dos`,
      );
    }
  }

  // ── 7. Una sección encendida no puede venir vacía ──────────────────────
  if (isSectionEnabled(content.enabledSections, "servicios") && services.length === 0) {
    romper(tenantId, "la sección de servicios está encendida y el local no tiene catálogo");
  }
  if (isSectionEnabled(content.enabledSections, "profesionales") && employees.length === 0) {
    romper(tenantId, "la sección de profesionales está encendida y el local no tiene personas");
  }
  if (isSectionEnabled(content.enabledSections, "experiencia") && content.experienceSteps.length === 0) {
    romper(tenantId, "la sección de experiencia está encendida y no hay ni un paso");
  }
  if (isSectionEnabled(content.enabledSections, "info") && content.practicalInfo.items.length === 0) {
    romper(tenantId, "la sección de información práctica está encendida y no hay ni un dato");
  }
  if (isSectionEnabled(content.enabledSections, "faq") && content.faq.length === 0) {
    romper(tenantId, "la sección de preguntas está encendida y no hay ni una");
  }
  if (!isSectionEnabled(content.enabledSections, ALWAYS_ON_SECTION)) {
    romper(tenantId, "el asistente de reserva no se puede apagar");
  }
}
