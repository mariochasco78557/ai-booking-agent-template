import type { TenantPublicContent } from "../model.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * EL CONTENIDO PÚBLICO DEL SEGUNDO LOCAL, «Peluquería Aralar». SÓLO COPY.
 *
 * Este local es ENTERAMENTE INVENTADO: no representa a ningún negocio real, no
 * está inspirado en ninguno y no comparte ni una frase con el bloque de copy
 * del otro local del registro. Ese aislamiento no es estilo, es la condición
 * que hace demostrable el aislamiento entre locales: si una frase se repitiera
 * en los dos, el barrido por pares no podría distinguir qué página la produjo.
 *
 * Aquí tampoco hay ni un precio, ni una duración, ni una hora de reloj, ni la
 * lista de servicios de cada persona: el catálogo, la matriz de capacidades y
 * los horarios semanales viven en el núcleo y llegan a la pantalla derivados.
 * El validador de `./validate.js` rechaza el arranque si aparecen.
 *
 * LA VOZ DE ESTE LOCAL es corta, hablada y sin letra pequeña, con el verbo
 * «pedir hora». Nada de premios, antigüedad, valoraciones, dirección ni forma
 * de contacto, y ninguna promesa que la pantalla no cumpla.
 * ────────────────────────────────────────────────────────────────────────
 */
export const DEMO_DOS_CONTENT: TenantPublicContent = {
  seo: {
    description:
      "Pide hora en Peluquería Aralar sin llamar: marcas servicio, persona y hueco libre. " +
      "Página de demostración, con personas y agenda inventadas.",
  },

  demoBanner: "Estás en una demostración. Ni el equipo ni la agenda que ves existen.",

  /**
   * EL DIBUJO DE APERTURA, Y NO EL DEL OTRO LOCAL EN OTRO COLOR.
   *
   * Una retícula de rombos concéntricos dentro de un marco, con sus cuatro
   * marcas de registro: geometría sobria, de trazo fino, que va con el índigo y
   * que no dice «barbería» por ninguna parte —ni tijeras, ni navaja, ni poste—.
   * Este local no cuenta el oficio: cuenta que entras, se hace y sales.
   */
  heroEmblem: "rombos-concentricos",

  hero: {
    eyebrow: "Peluquería de barrio",
    headline: "Pide hora y listo.",
    subheadline:
      "Marcas qué te haces, con quién y cuándo. La pantalla enseña sólo lo que queda " +
      "libre, así que no hay nada que negociar ni nadie a quien esperar.",
    primaryCtaLabel: "Pedir hora",
    secondaryCtaLabel: "Ver qué hacemos",
    highlights: [
      "Sin llamadas: se pide desde aquí y punto.",
      "Lo que sale libre, está libre.",
      "Sin letra pequeña y sin sustos al pagar.",
    ],
  },

  /**
   * LOS RÓTULOS DE SECCIÓN. Cortos y hablados, como el resto de este local, y
   * sin una sola palabra en común con los del otro: aquí no hay «Servicios» ni
   * «El equipo», hay «Qué hacemos» y «Quién te atiende».
   *
   * Cada uno coincide palabra por palabra con la etiqueta del menú que apunta a
   * esa sección —lo exige el validador—, así que el titular de una sección
   * nunca puede desmentir al enlace por el que se ha llegado a ella.
   */
  sectionHeadings: {
    servicios: "Qué hacemos",
    profesionales: "Quién te atiende",
    experiencia: "Cómo va esto",
    reserva: "Pide tu hora",
    info: "Detalles",
    faq: "Dudas",
  },

  nav: {
    links: [
      { target: "servicios", label: "Qué hacemos" },
      { target: "profesionales", label: "Quién te atiende" },
      { target: "experiencia", label: "Cómo va esto" },
      { target: "info", label: "Detalles" },
      { target: "faq", label: "Dudas" },
    ],
    ctaLabel: "Pedir hora",
  },

  servicePresentation: [
    {
      serviceId: 0,
      category: "Sólo la barba",
      description:
        "Repasamos, igualamos y dejamos el contorno limpio. Es lo más corto que hay aquí, " +
        "y va bien para mantener entre visita y visita.",
      featured: false,
    },
    {
      serviceId: 1,
      category: "Corte",
      description:
        "Te preguntamos qué quieres, se hace y te lo enseñamos antes de terminar. Nadie " +
        "se levanta de la silla con una sorpresa encima.",
      featured: true,
    },
    {
      serviceId: 2,
      category: "Las dos cosas",
      description:
        "Todo en una sentada, para no tener que volver otro día. Va bien si andas justo " +
        "y prefieres salir resuelto de una vez.",
      featured: true,
    },
  ],

  professionalProfiles: [
    {
      employeeId: 21,
      role: "Responsable de sala",
      bio:
        "Lleva la agenda y la silla a la vez. Va al grano: te dice qué cabe hoy, qué no, " +
        "y no promete nada que luego no pueda cumplir.",
      specialties: ["Repasos rápidos", "Navaja", "Cuello y patillas"],
      initials: "IR",
    },
    {
      employeeId: 22,
      role: "Estilista",
      bio:
        "Corta rápido sin correr. Le pides algo concreto y sale igual la primera vez que " +
        "la quinta. Si ve que algo no te va a encajar, lo dice antes de empezar.",
      specialties: ["Pelo corto", "Máquina", "Flequillo bien rematado"],
      initials: "GO",
    },
  ],

  experienceSteps: [
    {
      title: "Dinos qué te haces",
      description: "Marca el servicio. Lo que ocupa en la agenda lo calcula la pantalla sola.",
    },
    {
      title: "Elige persona",
      description:
        "Puedes pedir por quien quieras. Si te da lo mismo, quédate con el primer nombre " +
        "que tenga sitio y a correr.",
    },
    {
      title: "Mira el hueco",
      description:
        "Se abre el panel y ves lo que queda suelto ese día. Lo ocupado ni se pulsa.",
    },
    {
      title: "Cierra la hora",
      description:
        "Repasas el resumen, confirmas, y la hora queda pedida a tu nombre. Aparece al " +
        "momento en el listado de reservas.",
    },
  ],

  practicalInfo: {
    items: [
      {
        kind: "access",
        label: "Cuando entras",
        value:
          "Di tu nombre en el mostrador y te colocamos. Si te has equivocado de hueco, se " +
          "ve ahí mismo y se arregla hablando.",
      },
      {
        kind: "policy",
        label: "La hora es la hora",
        value:
          "Si llegas tarde puede que no dé tiempo a todo. Mejor un poco antes que un poco " +
          "después: detrás viene otra persona.",
      },
      {
        kind: "payment",
        label: "Cómo se paga",
        value:
          "Aquí no se cobra nada. Puedes marcar el pago simulado o dejarlo para el " +
          "mostrador, y en ningún caso se piden datos de tarjeta.",
      },
      {
        kind: "policy",
        label: "Lo que esta demostración no hace",
        value:
          "Sólo pide horas nuevas. No anula, no cambia de día, no manda ningún aviso y no " +
          "apunta a nadie en espera de que se libere algo.",
      },
      {
        kind: "accessibility",
        label: "Teclado y tamaño de letra",
        value: "Todo se usa sin ratón, y el texto aguanta bien si lo agrandas.",
      },
    ],
    note:
      "Las personas de esta página están inventadas, y la agenda también. Nada de lo que " +
      "pidas aquí sale de esta pantalla.",
  },

  faq: [
    {
      question: "¿El equipo existe?",
      answer:
        "No. Son personas inventadas para la demostración. Las fichas se escribieron para " +
        "enseñar cómo queda la página, y detrás no hay nadie.",
    },
    {
      question: "¿Se pide hora de verdad?",
      answer:
        "Tampoco. Lo que confirmes se queda dentro de la demostración y se borra al " +
        "reiniciarla.",
    },
    {
      question: "¿La puedo anular después?",
      answer: "Desde aquí no. Esta pantalla pide horas nuevas; anular o mover se queda fuera.",
    },
    {
      question: "¿Por qué hay días en blanco?",
      answer:
        "Porque el local cierra esos días. Salen marcados como cerrados y no dejan pulsar.",
    },
    {
      question: "¿Dónde pone el precio?",
      answer:
        "En cada servicio, arriba. El importe y el tiempo salen del catálogo del local y no " +
        "de este texto, así que no pueden contradecirse.",
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

  footerTagline: "Peluquería Aralar · Entras, se hace, sales.",

  syntheticDisclosure:
    "Demostración: personas inventadas, agenda inventada y reservas que no salen de esta " +
    "pantalla. Ningún negocio real recibe nada de lo que se pida aquí.",
};
