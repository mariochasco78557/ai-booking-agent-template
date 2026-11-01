import type { EmployeeId, ServiceId } from "../callEngine/domain/types.js";
import {
  BOOKING_WEB_NOTICE,
  formatDurationLabel,
  formatEuros,
  type ProfessionalProfile,
  type PublicProfessionalView,
  type PublicServiceView,
  type ServiceCatalogEntry,
  type ServicePresentation,
  type TenantPublicView,
} from "./model.js";
import { openingWeekFor } from "./opening.js";
import type { TenantDefinition } from "./tenants.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * LA COSTURA ENTRE EL NÚCLEO Y LA WEB PÚBLICA. Es la ÚNICA.
 *
 * De un lado está `TenantDefinition`: catálogo con precios, personas con sus
 * capacidades, calendario entero y el «hoy» sintético. Del otro está
 * `TenantPublicView`: cadenas ya formateadas y nada más. Esta función es el
 * único paso de uno a otro, y por eso es el único sitio donde se decide cómo
 * se convierte un precio en texto o qué sabe hacer una persona.
 *
 * TRES INVARIANTES QUE ESTE FICHERO SOSTIENE:
 *
 * 1. EL ORDEN ES EL DEL NÚCLEO. Los servicios salen en el orden de
 *    `tenant.services` y las personas en el de `tenant.employees`, nunca en el
 *    del bloque de copy. Reordenar la presentación no reordena la portada, así
 *    que el copy no puede convertirse por accidente en un segundo catálogo con
 *    su propia jerarquía.
 * 2. LO QUE CADA PERSONA HACE SE DERIVA, NO SE DECLARA. `servicesLabel` y
 *    `serviceIds` salen de `DemoEmployee.serviceIds` —la misma matriz que
 *    consume el motor y que publica `/bootstrap`—, así que la portada no puede
 *    ofrecer un servicio que la reserva rechazaría después.
 * 3. SI FALTA UNA PIEZA, SE LANZA. El validador del contenido ya impide llegar
 *    hasta aquí con un servicio sin presentación o una persona sin ficha; esto
 *    es el tirante del cinturón, y protege también a quien construya una vista
 *    a mano en una prueba.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * El texto que une lo que una persona sabe hacer. Es un punto medio y no una
 * coma para que se lea como un rótulo y no como una enumeración a medias.
 */
const SERVICES_LABEL_SEPARATOR = " · ";

export function buildTenantPublicView(tenant: TenantDefinition): TenantPublicView {
  const presentacionPorServicio = new Map<ServiceId, ServicePresentation>(
    tenant.content.servicePresentation.map((p) => [p.serviceId, p]),
  );
  const fichaPorPersona = new Map<EmployeeId, ProfessionalProfile>(
    tenant.content.professionalProfiles.map((p) => [p.employeeId, p]),
  );
  const servicioPorId = new Map<ServiceId, ServiceCatalogEntry>(
    tenant.services.map((s) => [s.serviceId, s]),
  );

  // El ORDEN es el del NÚCLEO (`tenant.services`), no el del bloque de copy.
  const services = tenant.services.map((s): PublicServiceView => {
    const presentacion = presentacionPorServicio.get(s.serviceId);
    if (presentacion === undefined) {
      throw new Error(
        `Sin presentación para el servicio ${String(s.serviceId)} del local «${tenant.tenantId}».`,
      );
    }
    return {
      serviceId: s.serviceId,
      label: s.label,
      priceLabel: formatEuros(s.priceCents),
      durationLabel: formatDurationLabel(s.durationMinutes),
      category: presentacion.category,
      description: presentacion.description,
      featured: presentacion.featured,
    };
  });

  const professionals = tenant.employees.map((e): PublicProfessionalView => {
    const ficha = fichaPorPersona.get(e.employeeId);
    if (ficha === undefined) {
      throw new Error(
        `Sin ficha para la persona ${String(e.employeeId)} del local «${tenant.tenantId}».`,
      );
    }

    // DERIVADO de la única matriz de capacidades que existe, y acotado al
    // catálogo DE ESTE LOCAL: una capacidad que este local no vende no se
    // anuncia, porque no se podría reservar.
    const capacidades = e.serviceIds.filter((id) => servicioPorId.has(id));

    return {
      employeeId: e.employeeId,
      displayName: e.displayName,
      role: ficha.role,
      bio: ficha.bio,
      specialties: ficha.specialties,
      initials: ficha.initials,
      servicesLabel: capacidades
        .map((id) => servicioPorId.get(id)?.label ?? "")
        .filter((label) => label !== "")
        .join(SERVICES_LABEL_SEPARATOR),
      serviceIds: capacidades,
    };
  });

  return {
    tenantId: tenant.tenantId,
    brand: tenant.brand,
    seo: tenant.content.seo,
    demoBanner: tenant.content.demoBanner,
    hero: tenant.content.hero,
    // Los dos campos que cierran «el segundo local es el primero repintado»:
    // el dibujo de apertura y los rótulos de sección son DEL LOCAL, y la
    // plantilla se limita a traducir el primero y a imprimir los segundos.
    heroEmblem: tenant.content.heroEmblem,
    nav: tenant.content.nav,
    sectionHeadings: tenant.content.sectionHeadings,
    services,
    professionals,
    experience: tenant.content.experienceSteps,
    practicalInfo: tenant.content.practicalInfo,
    week: openingWeekFor(tenant),
    faq: tenant.content.faq,
    enabledSections: tenant.content.enabledSections,
    footerTagline: tenant.content.footerTagline,
    syntheticDisclosure: tenant.content.syntheticDisclosure,
    // El literal contractual, SIEMPRE. Ni el local ni la plantilla lo reformulan.
    notice: BOOKING_WEB_NOTICE,
  };
}
