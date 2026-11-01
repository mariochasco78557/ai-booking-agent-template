import type { TenantPublicContent } from "../model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * EL CONTENIDO PÚBLICO DEL LOCAL PRINCIPAL. SÓLO COPY.
 *
 * Aquí no hay ni un precio, ni una duración, ni una hora de reloj, ni la lista
 * de servicios que sabe hacer cada persona. Todo eso existe UNA vez en el
 * núcleo —el catálogo de `tenants.ts`, la matriz de capacidades de las personas
 * sintéticas y los horarios semanales del calendario— y la pantalla lo recibe
 * ya derivado. Escribirlo otra vez aquí crearía una segunda verdad que se
 * desviaría de la primera el día que alguien cambie un precio o un turno, y el
 * validador de `./validate.js` rechaza el arranque si aparece.
 *
 * LA VOZ DE ESTE LOCAL es la del oficio: calma, ritmo, tono editorial, y el
 * verbo «reservar». El segundo local tiene la suya, deliberadamente distinta,
 * y ninguna frase se comparte entre los dos ficheros.
 *
 * TODO LO QUE SE CUENTA AQUÍ ES SINTÉTICO, y el copy lo dice en tres capas:
 * la franja superior (`demoBanner`), la nota bajo las fichas del equipo
 * (`practicalInfo.note`, reforzada por `syntheticDisclosure`) y una pregunta
 * frecuente dedicada. No se afirma nada verificable sobre el negocio real: ni
 * antigüedad, ni premios, ni valoraciones, ni dirección, ni forma de contacto.
 * ────────────────────────────────────────────────────────────────────────
 */
export const BOOKING_DEMO_CONTENT: TenantPublicContent = {
  seo: {
    description:
      "Demostración de reserva de citas para Demo Salon: elige el servicio, " +
      "elige a quien te atiende y quédate con el hueco. Equipo y agenda ficticios.",
  },

  demoBanner:
    "Esto es una demostración: el equipo, la agenda y las citas que veas están inventados.",

  /**
   * EL DIBUJO DE APERTURA. Dos hojas cruzadas dentro de un anillo doble: el
   * oficio, dicho con trazo y sin una palabra. Es de este local y sólo de este:
   * el otro abre con otro dibujo, no con éste en otro color.
   */
  heroEmblem: "tijeras-cruzadas",

  hero: {
    eyebrow: "Barbería de oficio",
    headline: "Siéntate. Aquí el tiempo va a otro ritmo.",
    subheadline:
      "Trabajamos despacio y con la tijera en la mano. Elige el servicio, elige a quien " +
      "quieres delante y reserva tu cita: el hueco queda apartado en la agenda a tu nombre.",
    primaryCtaLabel: "Reservar cita",
    secondaryCtaLabel: "Ver los servicios",
    highlights: [
      "Cada servicio ocupa en la agenda el tiempo que de verdad necesita.",
      "Eliges tú quién te atiende, y no te lo asigna nadie.",
      "Sólo se ofrecen los huecos en los que cabe lo que has pedido.",
    ],
  },

  /**
   * LOS RÓTULOS DE SECCIÓN, con la voz de este local y no con la del producto.
   *
   * Cada uno es, PALABRA POR PALABRA, la etiqueta con la que el menú de abajo
   * anuncia esa misma sección: el validador lo exige, así que nadie puede
   * cambiar uno de los dos y dejar que la página se llame a sí misma de dos
   * maneras. `reserva` no aparece en el menú —su acceso es el botón de acción—
   * y por eso es el único rótulo que no tiene pareja arriba.
   */
  sectionHeadings: {
    servicios: "Servicios",
    profesionales: "El equipo",
    experiencia: "Cómo trabajamos",
    reserva: "Aparta tu hueco",
    info: "Antes de venir",
    faq: "Preguntas",
  },

  nav: {
    links: [
      { target: "servicios", label: "Servicios" },
      { target: "profesionales", label: "El equipo" },
      { target: "experiencia", label: "Cómo trabajamos" },
      { target: "info", label: "Antes de venir" },
      { target: "faq", label: "Preguntas" },
    ],
    ctaLabel: "Reservar cita",
  },

  servicePresentation: [
    {
      serviceId: 0,
      category: "Ritual de navaja",
      description:
        "Toalla caliente, perfilado a navaja y la forma que le va a tu cara. Se sale con " +
        "la piel tranquila y el dibujo limpio, sin que parezca recién hecho.",
      featured: false,
    },
    {
      serviceId: 1,
      category: "Tijera y máquina",
      description:
        "Lavado, corte y acabado. Primero escuchamos cómo llevas el pelo el resto de la " +
        "semana, porque se corta para eso y no para el día de la foto.",
      featured: true,
    },
    {
      serviceId: 2,
      category: "La visita completa",
      description:
        "Pelo y barba pensados juntos, en la misma sesión. La proporción entre uno y otra " +
        "se decide de una vez, delante del espejo, en lugar de a trozos.",
      featured: true,
    },
  ],

  professionalProfiles: [
    {
      employeeId: 3,
      role: "Barbero",
      bio:
        "Antes de tocar el pelo da una vuelta alrededor de la silla. Le gusta el trabajo " +
        "lento, el que se nota tres semanas después y no sólo al levantarse del sillón.",
      specialties: ["Trabajo a tijera", "Degradados suaves", "Contorno a navaja"],
      initials: "AL",
    },
    {
      employeeId: 6,
      role: "Barbero",
      bio:
        "Mano firme y ninguna prisa. Escucha lo que pides, lo repite en voz alta y sólo " +
        "entonces empieza. Si dudas, te propone dos caminos y te deja elegir a ti.",
      specialties: ["Máquina al detalle", "Perfilado de nuca", "Forma de la barba"],
      initials: "DA",
    },
    {
      employeeId: 9,
      role: "Estilista de sala",
      bio:
        "Piensa el pelo por cómo cae, no por cómo queda peinado el primer día. Pregunta " +
        "mucho antes de empezar y va explicando lo que hace mientras lo hace.",
      specialties: ["Cambios de largo", "Pelo con rizo", "Acabado que aguanta"],
      initials: "NE",
    },
  ],

  experienceSteps: [
    {
      title: "Elige el servicio",
      description:
        "Empieza por lo que vienes a hacerte. El tiempo que ocupa ya está apartado en la " +
        "agenda, así que no hay que calcular nada por tu cuenta.",
    },
    {
      title: "Elige quién te atiende",
      description:
        "Cada persona del equipo tiene su mano. Si te da igual, quédate con quien tenga " +
        "hueco antes; si no, espera a quien quieras y ya está.",
    },
    {
      title: "Escoge el día",
      description:
        "Se abre el panel de la agenda y aparecen sólo los huecos libres. Lo que ya está " +
        "ocupado no se puede pulsar, así que no hay forma de pedir algo imposible.",
    },
    {
      title: "Confirma y listo",
      description:
        "Antes de cerrar nada tienes el resumen delante. Al confirmar, la cita queda " +
        "escrita a tu nombre y se ve enseguida en el panel de reservas.",
    },
  ],

  practicalInfo: {
    items: [
      {
        kind: "access",
        label: "Al llegar",
        value:
          "Di tu nombre al entrar y siéntate. Preferimos terminar bien lo que hay en la " +
          "silla antes que ir corriendo por acabar a tiempo.",
      },
      {
        kind: "policy",
        label: "Puntualidad",
        value:
          "Ven con algo de margen. Si te retrasas mucho puede que ya no quepa el servicio " +
          "entero, porque detrás de ti hay otra cita esperando.",
      },
      {
        kind: "payment",
        label: "Pago",
        value:
          "En esta demostración puedes marcar el pago simulado o dejarlo para el local. " +
          "No se cobra nada, no se pide ningún dato de tarjeta y no se mueve dinero.",
      },
      {
        kind: "policy",
        label: "Lo que esta web todavía no hace",
        value:
          "Aquí sólo se crean citas nuevas. Cambiarlas o anularlas no se puede desde esta " +
          "pantalla, no se envía ningún aviso y nada de esto llega a la agenda del salón.",
      },
      {
        kind: "accessibility",
        label: "Accesibilidad",
        value:
          "La página se recorre entera con el teclado y el texto se puede agrandar sin que " +
          "se rompa la composición ni se pierda ningún botón.",
      },
    ],
    note:
      "El equipo que aparece en esta página está inventado para la demostración. Los " +
      "nombres, las fichas y la agenda que los acompaña son ficticios, y ninguna reserva " +
      "hecha aquí llega al salón.",
  },

  faq: [
    {
      question: "¿Las personas del equipo son reales?",
      answer:
        "No. Son perfiles inventados para esta demostración, con nombre y manera de " +
        "trabajar escritos para la ocasión. No corresponden a nadie del salón.",
    },
    {
      question: "¿Esta reserva llega de verdad al salón?",
      answer:
        "No. Lo que confirmes se guarda sólo en esta demostración, para poder enseñar el " +
        "recorrido completo, y desaparece en cuanto se reinicia.",
    },
    {
      question: "¿Puedo anular o cambiar la cita desde aquí?",
      answer:
        "Todavía no. Esta pantalla sabe crear citas nuevas y nada más; cualquier otra cosa " +
        "hay que hablarla en el salón.",
    },
    {
      question: "¿Dónde veo lo que cuesta y lo que dura cada servicio?",
      answer:
        "En la ficha de cada servicio. El importe y el tiempo salen del catálogo del local, " +
        "no de este texto, y por eso siempre coinciden con lo que ocupa en la agenda.",
    },
    {
      question: "¿Por qué no me deja elegir cualquier hueco?",
      answer:
        "Porque sólo se ofrecen aquellos en los que cabe entero el servicio que has pedido, " +
        "con la persona que has pedido. Si el local cierra ese día, no aparece ninguno.",
    },
  ],

  enabledSections: {
    hero: true,
    servicios: true,
    profesionales: true,
    experiencia: true,
    info: true,
    faq: true,
  },

  footerTagline: "Demo Salon — el oficio, sin prisa.",

  syntheticDisclosure:
    "Todo lo que se ve aquí está inventado: el equipo, la agenda, los huecos y las " +
    "reservas. Es una demostración de cómo se pide una cita, no la agenda del salón.",
};
