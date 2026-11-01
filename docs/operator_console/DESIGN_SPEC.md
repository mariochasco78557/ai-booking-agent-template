# Consola de operación de Demo Salon — Especificación de diseño (step 14)

Rama: `mission/demo-salon-operator-console-ux-v1` · Base: `5ce7d7a`
Ámbito: `src/console/ui.html.ts`, `src/console/ui.css.ts`, `src/console/ui.js.ts`,
más los tres añadidos de servidor descritos en el **Anexo A**.

Este documento es la especificación literal que van a implementar otros agentes.
Cuando dice "exactamente", es exactamente.

---

## 0. Estado de cada afirmación de este documento

Se distingue de forma explícita, porque la mitad de los errores caros de esta
misión vendrían de confundir estas cuatro cosas.

| Marca | Significado |
| --- | --- |
| **[V]** | Hecho verificado leyendo el código de esta rama. |
| **[R]** | Requisito de cliente / de la misión. No negociable por diseño. |
| **[P]** | Propuesta de diseño de este documento. Decidida, pero es una decisión, no un hecho. |
| **[G]** | Hueco abierto: el requisito existe y el código todavía no lo soporta. Ver Anexo B. |

Cosas que conviene tener presentes antes de leer nada más:

- **[V]** La consola es un proceso Fastify aparte (`src/console/server.ts`), atado
  a `127.0.0.1` por una constante fija (`src/console/config.ts:27`), puerto 4310
  por defecto, apagada salvo `CALL_ENGINE_CONSOLE_ENABLED`.
- **[V]** La CSP es `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'`.
  **No incluye `img-src`.** Con `default-src 'none'`, *cualquier* imagen queda
  bloqueada, incluidos el logotipo y el favicon. Sin el cambio del Anexo A.2 el
  logotipo no se ve. Esto no es una opinión: es cómo funciona el respaldo a
  `default-src`.
- **[V]** Sin bundler, sin framework, sin dependencia npm de UI. Tres módulos de
  plantilla en TypeScript servidos como rutas: `/`, `/app.css`, `/app.js`.
- **[V]** El navegador sólo escribe con `textContent`. `innerHTML` no aparece y
  hay un test que hace grep del fichero en disco.
- **[V]** Los datos llegan por sondeo (`GET /api/snapshot`) cada 2000 ms.
- **[V]** La latencia **no se recoge** (`docs/call_interruption_mvp/PILOT_METRICS.md`).
  Nunca se muestra un número de latencia. Ver §11 para el único sitio donde se
  menciona su ausencia.
- **[V]** `EmployeeAbsence.privateReason` no sale del servidor. `snapshot.ts` no
  lo lee nunca (`sanitizeAbsence`).
- **[G]** El horario estacional de agosto **no existe en el modelo de datos**. El
  código implementa **seis** niveles de precedencia, no siete. Ver Anexo B.1.
- **[G]** El horario semanal de la fixture (`syntheticVenue.ts`) **no coincide**
  con el horario de negocio declarado. Ver Anexo B.2.

---

## 1. Principios de diseño

Cinco. Cada uno resuelve discusiones concretas, y por eso están redactados como
reglas de decisión, no como valores.

### P1. La pantalla contesta una pregunta, no exhibe un sistema

La pregunta de Bruno es *"¿qué está pasando ahora mismo y hay algo que necesite mi
atención?"*. Todo elemento que no ayude a contestarla o a actuar sobre ella se va
a **Laboratorio** o se borra. Regla operativa: si un dato no cambia ninguna
decisión de Bruno en los próximos diez minutos, no va en Inicio.

### P2. Honestidad antes que buena cifra

Si el motor dice `DERIVA`, la pantalla dice "Derivada a una persona", aunque
quede peor. Si una llamada se entendió pero no se cerró reserva, se cuenta como
**No completada** y **no** como contención — exactamente lo que decide
`OUTCOME_DIMENSIONS.BOOKING_NOT_CONFIRMED` (`countsAsContained: false`). Toda
tasa se muestra con numerador y denominador visibles ("3 de 7"), nunca sólo el
porcentaje. Nunca se inventa un cero para un dato que no se mide.

### P3. Lo técnico existe, pero está en su cuarto

Los códigos `A01..A15`, los `callIdHash`, los `reasonCode`, los nombres de
evento, el JSON crudo y la inyección de fallos existen y son valiosos: viven en
**Laboratorio**. En las cinco secciones operativas no aparecen como etiqueta
principal jamás; como mucho, como dato secundario dentro de un detalle que hay
que abrir a propósito.

### P4. Nada cambia solo

Ninguna reserva sintética se cancela ni se mueve sin que Bruno vea la vista previa
y resuelva una por una. La interfaz nunca ofrece un botón que "arregle" varias
reservas de golpe. `applyChange` ya lo impide en el servidor; la interfaz no debe
sugerir siquiera que existe ese atajo.

### P5. El color no informa; acompaña

Cada estado se distingue por **texto + símbolo + tratamiento de borde**, y
además por color. Quitar el color de la pantalla no debe hacer perder ni un solo
dato. Esto no es un detalle de accesibilidad: es que Bruno va a mirar esta
pantalla de reojo, de pie y con luz de escaparate.

---

## 2. Arquitectura de información

### 2.1 Las seis secciones

| Sección | Ruta | La pregunta que contesta | Lo que NUNCA aparece aquí |
| --- | --- | --- | --- |
| **Inicio** | `#/inicio` | ¿Va bien ahora mismo y hay algo que atender? | Escenarios, JSON, hashes, códigos técnicos |
| **Agenda** | `#/agenda` | ¿Qué citas hay hoy y los próximos días? | Precios, datos de cliente, códigos técnicos |
| **Llamadas** | `#/llamadas` | ¿Qué ha hecho el asistente en cada llamada? | El hash como etiqueta principal |
| **Calendario** | `#/calendario` | ¿Qué días son distintos y qué pasa si cambio uno? | Motivos privados de ausencia |
| **Equipo** | `#/equipo` | ¿Quién trabaja, cuándo, y quién falta? | `privateReason`, cualquier dato personal real |
| **Laboratorio** | `#/laboratorio` | ¿Cómo demuestro y depuro el motor? | (aquí sí va todo lo técnico) |

Orden en la barra lateral: **Inicio · Agenda · Llamadas · Calendario · Equipo ·
Laboratorio**. Laboratorio va separado por un filete y bajo el rótulo
`Herramientas de demostración`, para que no se lea como una sexta sección
operativa más.

### 2.2 Las tres capas de divulgación progresiva

Toda la consola se organiza en tres capas. Un dato sólo sube de capa si Bruno lo
necesita para decidir.

**Capa 1 — Resumen (Inicio).**
Cifras y tarjetas de atención. Sin tablas largas. Todo elemento de esta capa es
un enlace a la capa 2 filtrada por el mismo criterio.

**Capa 2 — Detalle operativo (Agenda, Llamadas, Calendario, Equipo).**
Listas y fichas en castellano llano: hora, profesional, servicio, estado, qué
hay que hacer. Aquí hay un panel de detalle por elemento (llamada, cita,
excepción) que muestra el "qué pasó" en lenguaje natural.

**Capa 3 — Detalle técnico (dentro del detalle de capa 2 + Laboratorio).**
En capa 2, cada panel de detalle termina con un bloque plegado
`<details>` rotulado **"Detalle técnico"**, cerrado por defecto, con
`callIdHash`, `scenarioId`, `reasonCode`, `internalReasonCode`, `outcome`, los
tres booleanos de métrica y las marcas de tiempo ISO. En Laboratorio esa misma
información está desplegada, más el JSON crudo, el ejecutor de escenarios, los
contadores de eventos y el reinicio destructivo.

### 2.3 Los diez caminos que deben resolverse en ≤ 2 acciones

| Necesidad | Camino | Acciones |
| --- | --- | --- |
| ¿Funciona el asistente? | Inicio (vista inicial) | 0 |
| ¿Qué necesita mi atención? | Inicio → bloque "Necesita tu atención" | 0 |
| Encontrar una cita próxima | Inicio → "Ver toda la agenda" (o barra → Agenda) | 1 |
| Inspeccionar una llamada derivada | Inicio → tarjeta de atención (abre `#/llamadas/<hash>`) | 1 |
| ¿El fallo técnico tocó una reserva? | Inicio → tarjeta "Fallo técnico con reserva escrita" | 1 |
| Ver el horario de agosto | Calendario → el mes ya está a la vista con su aviso | 1 |
| Ver/añadir festivo o cierre | Calendario → "Añadir día especial" | 2 |
| Ver/añadir ausencia | Equipo → "Añadir ausencia" | 2 |
| Vista previa de impacto antes de publicar | Es un paso obligado del propio formulario | 0 extra |
| Llegar al ejecutor de escenarios | Barra lateral → Laboratorio | 1 |

---

## 3. Tokens de diseño

Tabla lista para pegar en `src/console/ui.css.ts` dentro de `:root`. Los ratios
de contraste están **calculados** sobre estos hex exactos (fórmula WCAG 2.x de
luminancia relativa), no estimados.

### 3.1 Color — superficies y texto

```css
:root {
  /* --- Tinta y superficies claras --- */
  --tx-ink-900:      #171615;  /* barra lateral, texto principal */
  --tx-ink-800:      #2A2724;  /* hover de la barra lateral */
  --tx-ink-700:      #3D3833;  /* texto secundario fuerte */
  --tx-ink-500:      #57504A;  /* texto atenuado */
  --tx-ivory-50:     #F5F1E8;  /* fondo del área de trabajo */
  --tx-surface:      #FFFFFF;  /* tarjetas y tablas */
  --tx-surface-alt:  #EFE9DD;  /* cabeceras de tabla, franjas */
  --tx-sand-100:     #EBE4D6;  /* superficies secundarias */

  /* --- Líneas --- */
  --tx-line:         #D8D2C7;  /* separador decorativo (no informativo) */
  --tx-line-strong:  #7E766A;  /* borde de control (input, select, tab) */

  /* --- Acento cobre/coñac --- */
  --tx-copper-700:   #8F4F2A;  /* TEXTO cobre y fondo de botón primario */
  --tx-copper-500:   #B86A3C;  /* acento NO textual: barra activa, filete */
  --tx-copper-200:   #E0A87E;  /* acento sobre la barra lateral oscura */
  --tx-copper-50:    #F6EAE0;  /* relleno de píldora "Derivada" */

  /* --- Estados --- */
  --tx-green-700:    #1E6B3A;
  --tx-green-50:     #E4F0E7;
  --tx-amber-800:    #8A5300;
  --tx-amber-50:     #FAEFD8;
  --tx-red-700:      #B3261E;
  --tx-red-50:       #F8E6E4;
  --tx-neutral-700:  #57504A;
  --tx-neutral-50:   #EDE9E0;

  /* --- Barra lateral --- */
  --tx-sidebar-bg:      #171615;
  --tx-sidebar-text:    #F5F1E8;
  --tx-sidebar-muted:   #C9C2B8;
  --tx-sidebar-active:  #332F2B;
  --tx-sidebar-line:    #3A3531;

  /* --- Foco --- */
  --tx-focus-dark:   #171615;  /* anillo sobre superficie clara */
  --tx-focus-light:  #F5F1E8;  /* anillo sobre la barra lateral */
}
```

### 3.2 Ratios de contraste calculados

Pares reales que aparecen en la interfaz. AA normal exige 4.5:1; AA grande
(≥ 18.66 px normal o ≥ 14 px negrita) exige 3:1; elementos no textuales y
límites de componente exigen 3:1.

| Uso | Texto/elemento | Fondo | Ratio | Cumple |
| --- | --- | --- | --- | --- |
| Texto principal en área de trabajo | `#171615` | `#F5F1E8` | **16.03:1** | AAA |
| Texto principal en tarjeta | `#171615` | `#FFFFFF` | **18.07:1** | AAA |
| Texto principal en franja | `#171615` | `#EFE9DD` | **14.95:1** | AAA |
| Texto secundario fuerte | `#3D3833` | `#F5F1E8` | **10.28:1** | AAA |
| Texto atenuado en tarjeta | `#57504A` | `#FFFFFF` | **7.92:1** | AAA |
| Texto atenuado en área de trabajo | `#57504A` | `#F5F1E8` | **7.03:1** | AAA |
| Texto atenuado en franja | `#57504A` | `#EFE9DD` | **6.77:1** | AAA |
| Texto de barra lateral | `#F5F1E8` | `#171615` | **16.03:1** | AAA |
| Texto atenuado de barra lateral | `#C9C2B8` | `#171615` | **10.23:1** | AAA |
| Ítem activo de barra lateral | `#F5F1E8` | `#332F2B` | **11.77:1** | AAA |
| Barra indicadora activa (no textual) | `#B86A3C` | `#171615` | **4.44:1** | ≥3:1 |
| Acento cobre sobre barra lateral | `#E0A87E` | `#171615` | **8.67:1** | AAA |
| Texto cobre sobre tarjeta | `#8F4F2A` | `#FFFFFF` | **6.33:1** | AA |
| Texto cobre sobre área de trabajo | `#8F4F2A` | `#F5F1E8` | **5.61:1** | AA |
| Botón primario | `#FFFFFF` | `#8F4F2A` | **6.33:1** | AA |
| Píldora "Reserva confirmada" | `#1E6B3A` | `#E4F0E7` | **5.57:1** | AA |
| Píldora "Necesita revisión" | `#8A5300` | `#FAEFD8` | **5.55:1** | AA |
| Píldora "Error técnico" | `#B3261E` | `#F8E6E4` | **5.43:1** | AA |
| Píldora "Derivada a una persona" | `#8F4F2A` | `#F6EAE0` | **5.35:1** | AA |
| Píldora "No completada" / "Sin incidencias" | `#57504A` | `#EDE9E0` | **6.54:1** | AA |
| Botón destructivo | `#FFFFFF` | `#B3261E` | **6.54:1** | AA |
| Borde de control | `#7E766A` | `#FFFFFF` | **3.74:1** | ≥3:1 |
| Borde de control sobre marfil | `#7E766A` | `#F5F1E8` | **3.32:1** | ≥3:1 |
| Anillo de foco sobre claro | `#171615` | `#FFFFFF` | **18.07:1** | ≥3:1 |
| Anillo de foco sobre barra lateral | `#F5F1E8` | `#171615` | **16.03:1** | ≥3:1 |

**Dos prohibiciones que salen directamente de estos números:**

1. `--tx-copper-500` (`#B86A3C`) da **4.07:1** sobre blanco y **3.61:1** sobre
   marfil. **Nunca se usa para texto.** Sólo barra activa, filetes y adornos no
   informativos. Para texto cobre, `--tx-copper-700`.
2. `--tx-line` (`#D8D2C7`) da **1.50:1** sobre blanco. **Nunca se usa como borde
   de un control** ni como único indicador de un límite que aporte información.
   Para eso, `--tx-line-strong`.

### 3.3 Tipografía

```css
:root {
  --tx-font-sans: system-ui, -apple-system, "Segoe UI", Roboto,
                  "Helvetica Neue", Arial, sans-serif;
  --tx-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas,
                  "Liberation Mono", monospace;

  --tx-size-100: 0.75rem;    /* 12px — sólo rótulos en versalitas */
  --tx-size-200: 0.8125rem;  /* 13px — metadatos de tabla */
  --tx-size-300: 0.875rem;   /* 14px — texto denso de tabla */
  --tx-size-400: 1rem;       /* 16px — texto por defecto */
  --tx-size-500: 1.125rem;   /* 18px — título de tarjeta */
  --tx-size-600: 1.375rem;   /* 22px — h2 de panel */
  --tx-size-700: 1.75rem;    /* 28px — h1 de vista */
  --tx-size-800: 2.25rem;    /* 36px — cifra de KPI */

  --tx-weight-regular: 400;
  --tx-weight-medium: 500;
  --tx-weight-semibold: 600;
  --tx-weight-bold: 700;

  --tx-leading-tight: 1.2;   /* titulares y cifras */
  --tx-leading-normal: 1.5;  /* texto corrido */
  --tx-leading-loose: 1.6;   /* párrafos explicativos largos */

  --tx-tracking-caps: 0.06em; /* sólo con --tx-size-100 en versalitas */
}
```

Reglas: **12 px sólo para rótulos en versalitas** (`text-transform: uppercase`)
con `--tx-tracking-caps`. Texto corrido nunca por debajo de 14 px. Las cifras
usan siempre `font-variant-numeric: tabular-nums` para que no bailen al
refrescar cada 2 s. `--tx-font-mono` sólo en Laboratorio y dentro de
`<details>` técnicos.

### 3.4 Espaciado, radios, sombras, bordes

```css
:root {
  --tx-space-1:  0.25rem;  /*  4px */
  --tx-space-2:  0.5rem;   /*  8px */
  --tx-space-3:  0.75rem;  /* 12px */
  --tx-space-4:  1rem;     /* 16px */
  --tx-space-5:  1.25rem;  /* 20px */
  --tx-space-6:  1.5rem;   /* 24px */
  --tx-space-8:  2rem;     /* 32px */
  --tx-space-10: 2.5rem;   /* 40px */
  --tx-space-12: 3rem;     /* 48px */
  --tx-space-16: 4rem;     /* 64px */

  --tx-radius-sm:   4px;   /* píldoras pequeñas, inputs */
  --tx-radius-md:   8px;   /* tarjetas, botones */
  --tx-radius-lg:   12px;  /* paneles grandes, diálogo */
  --tx-radius-pill: 999px; /* píldora de estado */

  --tx-shadow-1: 0 1px 2px rgba(23, 22, 21, 0.06),
                 0 1px 1px rgba(23, 22, 21, 0.04);
  --tx-shadow-2: 0 2px 4px rgba(23, 22, 21, 0.07),
                 0 8px 16px -8px rgba(23, 22, 21, 0.12);
  --tx-shadow-dialog: 0 24px 48px -12px rgba(23, 22, 21, 0.35);

  --tx-border-hairline: 1px solid var(--tx-line);
  --tx-border-control:  1px solid var(--tx-line-strong);
  --tx-border-accent:   3px solid var(--tx-copper-500);

  --tx-focus-ring: 2px;
  --tx-focus-offset: 2px;

  --tx-duration: 120ms;
  --tx-easing: ease-out;
}
```

> Corregido en step 16 (aviso D1). `--tx-focus-ring` decía `3px`; el token
> real, declarado en `:root` en `ui.css.ts`, es `2px`. Ver §9.1 para el resto
> del contrato de foco, incluido el halo de cobre que este bloque de tokens
> tampoco mencionaba.

Tratamiento de borde por defecto: **tarjetas con `--tx-border-hairline` +
`--tx-shadow-1`**, nunca sombra sola (en pantallas de tienda con reflejos la
sombra desaparece). Los paneles que agrupan varias tarjetas usan sólo borde, sin
sombra, para no apilar profundidades.

`@media (prefers-reduced-motion: reduce)` pone `--tx-duration: 0ms` y anula toda
`transition`. No hay ninguna animación en bucle en toda la consola.

---

## 4. La estructura de la aplicación (app shell)

### 4.1 Anatomía

```
┌──────────────┬──────────────────────────────────────────────────────────────┐
│  BARRA       │  CABECERA DE ÁREA DE TRABAJO (sticky)                        │
│  LATERAL     │  H1 de la vista        [Demo local · Datos sintéticos ·      │
│  (oscura)    │  Demo Salon Barbershop      No producción]   Actualizado: 12:41  │
│              ├──────────────────────────────────────────────────────────────┤
│  [logo]      │                                                              │
│              │  ÁREA DE TRABAJO (marfil, scroll propio)                     │
│  Inicio      │                                                              │
│  Agenda      │  ┌────────────────────────────────────────────────────────┐  │
│  Llamadas    │  │  paneles de la vista activa                            │  │
│  Calendario  │  └────────────────────────────────────────────────────────┘  │
│  Equipo      │                                                              │
│  ──────────  │                                                              │
│  HERRAMIEN.  │                                                              │
│  Laboratorio │                                                              │
│              │                                                              │
│  [pie]       │                                                              │
└──────────────┴──────────────────────────────────────────────────────────────┘
```

### 4.2 Barra lateral (`.tx-sidebar`)

- Fondo `--tx-sidebar-bg`, ancho fijo 216 px a ≥1440 px (200 px entre 1280 y
  1439 px).

  > Corregido en step 16 (aviso D1, extensión). Decía 264 px. La FASE 3A de
  > esta misma misión estrechó la barra a 216 px (200 px por debajo de
  > 1440 px) para ganar espacio operativo (regla base `.tx-sidebar` y su
  > variante dentro de `@media (max-width: 1439px)`, ambas en `ui.css.ts`);
  > ver también §4.5 más abajo, que tenía las mismas dos cifras desfasadas.
- **Zona de marca** (`.tx-brand`), arriba, `padding: var(--tx-space-4)`:
  - **[V]** `assets/brand/demo-salon-logo.png` es PNG 400×400 **color type 2, sin
    canal alfa**: el fondo blanco forma parte de la imagen.
  - Por tanto va sobre una **placa clara propia**, tal como exige
    (internal doc, not included in the template): `.tx-brand__plate` con
    `background: var(--tx-surface)`, `border-radius: var(--tx-radius-md)`,
    `padding: var(--tx-space-2)`, `box-shadow: var(--tx-shadow-1)`,
    `max-width: 132px` con `margin-inline: auto` (no el 100 % del contenido de
    la barra), y dentro `<img>` con `width: 100%; height: auto; display: block`.

  > Corregido en step 16 (reparación adversarial, 2ª ronda, F1). Este párrafo
  > decía `padding: var(--tx-space-5)` para `.tx-brand` y, para
  > `.tx-brand__plate`, `padding: var(--tx-space-3)` y «ancho 100 % del
  > contenido de la barra». La FASE 3A de esta misma misión (compactación de
  > Inicio y de la barra lateral) cambió ambos: la regla `.tx-brand` en
  > `ui.css.ts` usa `var(--tx-space-4)` y la regla `.tx-brand__plate` que la
  > sigue usa `var(--tx-space-2)` más el ancho máximo fijo y centrado que ya
  > se ha dado arriba, no un 100 % fluido.
  - **Prohibido** intentar recortar el fondo por CSS (`mix-blend-mode`,
    `filter`, máscara). (internal doc, not included in the template) ya explica por qué el resultado sería
    sucio en el grabado de las navajas y en la trama de la cinta.
  - `alt="Demo Salon Barbershop"`. Debajo, `.tx-brand__venue`:
    `Consola de operación` en `--tx-size-200`, `--tx-sidebar-muted`.
- **Navegación** (`<nav aria-label="Secciones de la consola">`) con
  `<ul>`/`<li>`/`<a href="#/...">`. Cada ítem: 44 px de alto mínimo,
  `padding: var(--tx-space-3) var(--tx-space-4)`, `--tx-size-400`.
  - Reposo: texto `--tx-sidebar-muted`.
  - Hover: fondo `--tx-ink-800`, texto `--tx-sidebar-text`.
  - Activo (`aria-current="page"`): fondo `--tx-sidebar-active`, texto
    `--tx-sidebar-text`, **barra izquierda de 3 px `--tx-copper-500`** y peso
    `--tx-weight-semibold`. Tres portadores no cromáticos: posición, peso y
    `aria-current`.
- **Separador** `--tx-sidebar-line` + rótulo `HERRAMIENTAS DE DEMOSTRACIÓN`
  (`--tx-size-100`, versalitas, `--tx-sidebar-muted`) antes de Laboratorio.
- **Pie de barra** (`.tx-sidebar__foot`): `127.0.0.1:4310` en `--tx-size-200`,
  `--tx-sidebar-muted`. Es el recordatorio permanente de que esto es local.

### 4.3 Cabecera del área de trabajo (`.tx-topbar`)

`position: sticky; top: 0; z-index: 20`, fondo `--tx-ivory-50` con
`border-bottom: var(--tx-border-hairline)`.

De izquierda a derecha:

1. `<h1 class="tx-topbar__title" tabindex="-1">` — el título de la vista activa.
   Es el destino del foco al navegar (§9.3).
2. **`.tx-badge-demo`** — la insignia obligatoria:
   `Demo local · Datos sintéticos · No producción`.
   - **[R]** Está escrita **literalmente en `ui.html.ts`**, como texto estático.
     Ningún script la rellena, la oculta ni la cambia. Así un fallo en `app.js`
     no puede hacerla desaparecer, que es exactamente el modo de fallo que
     importa.
   - Estilo: fondo `--tx-copper-700`, texto `#FFFFFF` (6.33:1),
     `--tx-radius-pill`, `--tx-size-200`, `--tx-weight-semibold`,
     `padding: var(--tx-space-1) var(--tx-space-3)`. Nunca desaparece en ningún
     punto de ruptura; en móvil pasa a segunda línea, no se recorta.
3. **`.tx-freshness`** — `Actualizado a las HH:mm:ss` (hora local real del
   navegador, derivada de `generatedAt`). Si han pasado más de 6 s sin sondeo
   correcto, cambia a `Sin conexión con el motor` con la píldora de error. Es la
   **única** afirmación de "en vivo" que se permite, y es cierta porque el sondeo
   la actualiza de verdad.

### 4.4 Área de trabajo (`.tx-workspace`)

`max-width: 1176px`, `margin-inline: auto`,
`padding: var(--tx-space-8) var(--tx-space-8) var(--tx-space-16)`.
Rejilla de 12 columnas: `display: grid; grid-template-columns: repeat(12, 1fr);
gap: var(--tx-space-6)`.

### 4.5 Comportamiento por punto de ruptura

Se escribe **desktop primero** con consultas `max-width` descendentes, porque el
uso real es un portátil en la barbería.

**≥ 1440 px (referencia).**
Barra lateral 216 px fija. Área de trabajo 1176 px máx.
KPI en 4 columnas (`span 3` cada una). Inicio en dos columnas: principal
`span 8`, lateral `span 4`. Tablas completas.

**1280–1439 px.**
Barra lateral 200 px. Área de trabajo `max-width: 1000px`,
`padding-inline: var(--tx-space-6)`. Los KPI siguen en 4 columnas (cada tarjeta
~232 px, suficiente para 36 px de cifra). Inicio sigue en 8/4.

> Corregido en step 16 (aviso D1, extensión). Decía 264 px y 240 px. La barra
> lateral se estrechó en FASE 3A de esta misma misión: la regla base
> `.tx-sidebar` en `ui.css.ts` (216 px a ≥1440 px) y su variante dentro de
> `@media (max-width: 1439px)` (200 px entre 1280 y 1439 px).

**1024–1279 px (tablet apaisada).**
- La barra lateral **colapsa a un raíl de 76 px**: desaparecen las etiquetas de
  texto y queda el **glifo "TX"** arriba (`.tx-brand__glyph`, §6.12) más las
  seis entradas con su símbolo y `aria-label` completo. El elemento activo
  conserva la barra cobre de 3 px. `title` + `aria-label` en cada enlace.
- KPI a 2 columnas (`span 6`).
- Inicio se apila: principal `span 12`, lateral `span 12` debajo.
- Las tablas mantienen su estructura pero envueltas en `.tx-table-scroll`
  (`overflow-x: auto`) con `tabindex="0"` y `aria-label` para que la región
  desplazable sea alcanzable por teclado.

**721–1023 px.**
- La barra lateral pasa a **barra superior** (`.tx-sidebar--top`): logotipo en su
  placa a la izquierda con altura 40 px, y navegación horizontal desplazable con
  `overflow-x: auto` y `scroll-snap-type: x proximity`. Se mantienen los 44 px de
  alto de destino.
- Todo a una columna. Los KPI a 2 columnas.
- La cabecera del área de trabajo deja de ser sticky para no comerse la pantalla.

**≤ 720 px (móvil estrecho, sin rotura destructiva).**
- KPI a 1 columna, cifra baja a `--tx-size-700`.
- **Las tablas se convierten en fichas apiladas**: `table`, `thead`, `tbody`,
  `tr`, `td` pasan a `display: block`; `thead` se oculta con `.tx-visually-hidden`;
  cada `td` lleva su rótulo mediante `content: attr(data-label)` en un `::before`
  definido en `app.css`. El atributo `data-label` lo pone el JS con
  `setAttribute` — permitido, no es `innerHTML` ni estilo en línea.
- Las acciones secundarias pasan a ancho completo, apiladas con
  `gap: var(--tx-space-3)`.
- Ancho mínimo soportado: **320 px**, sin recorte y sin desplazamiento
  horizontal del documento.

---

## 5. Wireframes por sección

Los textos de estos diagramas son la **copia real** que hay que implementar.

### 5.1 Inicio (`#/inicio`)

```
┌ CABECERA ──────────────────────────────────────────────────────────────────┐
│ Inicio        [Demo local · Datos sintéticos · No producción]              │
│                                          Actualizado a las 12:41:06        │
└────────────────────────────────────────────────────────────────────────────┘

┌ PANEL: contexto ───────────────────────────────────────────────────────────┐
│ ● Asistente sintético · Respondiendo                                       │
│ lunes, 3 de agosto de 2026                                                 │
│ Estos datos son de una demostración local. No hay ninguna línea            │
│ telefónica conectada y no se toca ningún sistema real de Demo Salon.           │
└────────────────────────────────────────────────────────────────────────────┘

┌ CIFRAS DEL DÍA (4 tarjetas) ───────────────────────────────────────────────┐
│ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐   │
│ │      7        │ │     4 de 7    │ │      3        │ │      1        │   │
│ │ Llamadas      │ │ Resueltas sin │ │ Reservas      │ │ Errores       │   │
│ │ atendidas hoy │ │ molestar a    │ │ creadas hoy   │ │ técnicos      │   │
│ │               │ │ nadie         │ │               │ │               │   │
│ │ Simuladas     │ │ Ver llamadas  │ │ Ver agenda    │ │ Ver detalle   │   │
│ └───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘   │
└────────────────────────────────────────────────────────────────────────────┘

┌ COLUMNA PRINCIPAL (span 8) ──────────┐ ┌ COLUMNA LATERAL (span 4) ────────┐
│                                      │ │                                  │
│ ## Necesita tu atención        (2)   │ │ ## Próximas citas de hoy         │
│ ┌──────────────────────────────────┐ │ │ ┌──────────────────────────────┐ │
│ │ ⚠ Necesita revisión              │ │ │ │ 12:30  Corte de pelo         │ │
│ │ Un fallo técnico pudo dejar una  │ │ │ │        Álex (sintético)      │ │
│ │ reserva escrita sin avisar al    │ │ │ │        ✓ Reserva confirmada  │ │
│ │ cliente.                         │ │ │ ├──────────────────────────────┤ │
│ │ Hoy a las 11:14                  │ │ │ │ 13:00  Corte y barba         │ │
│ │ [Ver la llamada]                 │ │ │ │        Dani (sintético)      │ │
│ ├──────────────────────────────────┤ │ │ │        ✓ Reserva confirmada  │ │
│ │ → Derivada a una persona         │ │ │ └──────────────────────────────┘ │
│ │ El cliente pidió hablar con      │ │ │ [Ver toda la agenda]             │
│ │ alguien del equipo.              │ │ │                                  │
│ │ Hoy a las 10:52                  │ │ │ ## Próximos días distintos       │
│ │ [Ver la llamada]                 │ │ │ ┌──────────────────────────────┐ │
│ └──────────────────────────────────┘ │ │ │ 15 ago · Local cerrado       │ │
│                                      │ │ │ Festivo aprobado             │ │
│ ## Cosas que hacer una persona (3)   │ │ ├──────────────────────────────┤ │
│ ┌──────────────────────────────────┐ │ │ │ 20–22 ago · Álex ausente     │ │
│ │ Devolver la llamada              │ │ │ │ Vacaciones                   │ │
│ │ Hoy a las 10:52   [Ver]          │ │ │ └──────────────────────────────┘ │
│ ├──────────────────────────────────┤ │ │ [Ver el calendario]              │
│ │ Llamar al cliente por un cambio  │ │ │                                  │
│ │ de calendario                    │ │ └──────────────────────────────────┘
│ │ Hoy a las 12:05   [Ver]          │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘

┌ LO ÚLTIMO QUE HA PASADO (fila propia, ancho completo · span 12) ────────────┐
│ ## Lo último que ha pasado                                                 │
│ ┌──────────────────────────────────────────────────────────────────────┐  │
│ │ 12:31 ✓ Reserva confirmada                                           │  │
│ │       Corte de pelo, mañana a las 10:00, con Dani                    │  │
│ ├──────────────────────────────────────────────────────────────────────┤  │
│ │ 12:18 ○ No completada                                                │  │
│ │       Se entendió lo que quería, pero no llegó a confirmar           │  │
│ ├──────────────────────────────────────────────────────────────────────┤  │
│ │ 11:55 — Sin incidencias                                              │  │
│ │       Se le dieron horas libres                                     │  │
│ └──────────────────────────────────────────────────────────────────────┘  │
│ [Ver todas las llamadas]                                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

> Corregido en step 16 (reparación adversarial, 2ª ronda, F1). Este mock
> tenía dos defectos que la FASE 3A dejó desfasados: (1) el panel de contexto
> abría con la línea de identidad (nombre del local + subtítulo de marca) que
> esa fase eliminó del HTML (la identidad ya la lleva el logo con su `alt`)
> — el orden real hoy es estado del asistente, fecha, nota; (2) "Lo último que
> ha pasado" aparecía dentro de la columna principal de `span 8`. La misma
> FASE 3A lo movió a su propia fila de ancho completo (`tx-col-12`, la
> sección `id="tit-actividad"` de "Lo último que ha pasado" en `ui.html.ts`)
> para que a ≤1279px no empujara a "Próximas citas" ni a "Próximos días
> distintos" hacia abajo.

Reglas de Inicio:

- **Nunca** aparece aquí `scenarioId`, `callIdHash`, `reasonCode` ni nombre de
  evento.
- La tarjeta "Resueltas sin molestar a nadie" muestra **siempre** numerador y
  denominador. Si el denominador es 0, muestra `Sin llamadas todavía` y no un
  `0 %`.
- "Lo último que ha pasado" son como máximo **5** entradas, ordenadas de más
  reciente a más antigua.
- "Próximas citas de hoy" son como máximo **4**; el resto está en Agenda.
- Ningún gráfico. Ninguna barra de progreso decorativa.

### 5.2 Agenda (`#/agenda`)

```
┌ CABECERA: Agenda ─────────────────────────────────────────────────────────┐

┌ CONTROLES ────────────────────────────────────────────────────────────────┐
│ [ Hoy ] [ Mañana ] [ Próximos 7 días ]     Profesional: [ Todos      ▾ ]  │
└───────────────────────────────────────────────────────────────────────────┘

┌ lunes, 3 de agosto de 2026 ───────────────────────────────────────────────┐
│ Horario del local: 09:00 – 17:30                                          │
│                                                                           │
│ HORA    SERVICIO         PROFESIONAL          ESTADO                      │
│ ─────────────────────────────────────────────────────────────────────────  │
│ 09:00   Corte de pelo    Álex (sintético)     ✓ Reserva confirmada    [›] │
│ 09:30   Corte de pelo    Álex (sintético)     ✓ Reserva confirmada    [›] │
│ 12:30   Corte y barba    Dani (sintético)     ✓ Reserva confirmada    [›] │
│ 15:30   Corte de pelo    Dani (sintético)     ⚠ Necesita revisión     [›] │
│                                                                           │
│ ── ya pasadas ─────────────────────────────────────────────────────────── │
│ 08:30   Barba            Nerea (sintética)    ✓ Reserva confirmada    [›] │
└───────────────────────────────────────────────────────────────────────────┘

┌ martes, 4 de agosto de 2026 ──────────────────────────────────────────────┐
│ Horario del local: 09:00 – 17:30                                          │
│                                                                           │
│ No hay ninguna cita este día.                                             │
└───────────────────────────────────────────────────────────────────────────┘

┌ miércoles, 5 de agosto de 2026 ───────────────────────────────────────────┐
│ Local cerrado · Festivo aprobado                                          │
└───────────────────────────────────────────────────────────────────────────┘
```

- La línea `── ya pasadas ──` separa lo anterior a la hora del motor. Las citas
  pasadas van con `opacity: 1` pero texto `--tx-ink-500`; **nunca** se ocultan.
- Duración: como toda cita dura 30 min (`SLOT_MINUTES`), la fila muestra sólo la
  hora de inicio y, en el detalle, `09:00 – 09:30`.
- **Nunca** se muestra precio, ni total, ni ocupación en euros.

### 5.3 Llamadas (`#/llamadas`)

```
┌ CABECERA: Llamadas ───────────────────────────────────────────────────────┐

┌ FILTROS ──────────────────────────────────────────────────────────────────┐
│ [ Todas (7) ] [ Necesitan atención (2) ] [ Con reserva (3) ]              │
│ [ Derivadas (1) ] [ Con error (1) ]                                       │
└───────────────────────────────────────────────────────────────────────────┘

┌ LISTA ────────────────────────────────────────────────────────────────────┐
│ HORA   QUÉ PEDÍA            RESULTADO                  QUÉ HAY QUE HACER  │
│ ────────────────────────────────────────────────────────────────────────── │
│ 12:31  Pedir cita           ✓ Reserva confirmada       Nada           [›] │
│ 12:18  Pedir cita           ○ No completada            Nada           [›] │
│ 11:55  Consultar horas      — Sin incidencias          Nada           [›] │
│ 11:14  Pedir cita           ✕ Error técnico            Revisar        [›] │
│ 10:52  Hablar con alguien   → Derivada a una persona   Devolver la    [›] │
│                                                        llamada            │
│ 10:40  Otra cosa            ⚠ Necesita revisión        Revisar        [›] │
└───────────────────────────────────────────────────────────────────────────┘

──── PANEL DE DETALLE (ruta #/llamadas/<hash>) ─────────────────────────────
┌───────────────────────────────────────────────────────────────────────────┐
│ Llamada de las 11:14                                          [Cerrar ✕]  │
│                                                                           │
│ ✕ Error técnico                                                           │
│                                                                           │
│ Qué pasó                                                                  │
│ El asistente falló mientras gestionaba la llamada. No le dijo al          │
│ cliente que la cita estuviera confirmada.                                 │
│                                                                           │
│ ⚠ Se escribió una reserva sintética antes del fallo.                      │
│    Hay que comprobar si esa cita sigue siendo válida.                     │
│    Reserva: 3 de agosto de 2026, 15:30, Corte de pelo, Dani (sintético)   │
│    [Ver la cita en la agenda]                                             │
│                                                                           │
│ Lo que pidió el cliente                                                   │
│ Pedir cita                                                                │
│                                                                           │
│ ¿Se dijo al cliente que estaba confirmada?                                │
│ No                                                                        │
│                                                                           │
│ ▸ Detalle técnico                                                         │
└───────────────────────────────────────────────────────────────────────────┘

──── "Detalle técnico" desplegado ──────────────────────────────────────────
│ Identificador de llamada (hash)  a3f1…9c2e            [Copiar]            │
│ Escenario                        A23-console-fallo-tecnico               │
│ Resultado (outcome)              DERIVA                                   │
│ Código congelado (reasonCode)    TECHNICAL_FAILURE                        │
│ Código interno                   TECHNICAL_FAILURE                        │
│ Cuenta como no entendida         No                                       │
│ Cuenta como reserva              No                                       │
│ Cuenta como contenida            No                                       │
│ Estado final                     ...                                      │
│ Inicio                           2026-08-02T11:14:00                      │
```

### 5.4 Calendario (`#/calendario`)

```
┌ CABECERA: Calendario ─────────────────────────────────────────────────────┐

┌ AVISO DE TEMPORADA (sólo si el mes visible está dentro de una) ───────────┐
│ ▣ Horario de agosto de 2026 · del 1 al 31 de agosto                       │
│ Martes 09:00-17:30. Miércoles 09:00-17:30. Jueves 09:00-17:30.            │
│ Viernes 09:00-17:30. Sábados 09:00-14:00. Cerrado: domingos, lunes.       │
│ Este horario solo está confirmado para 2026. No se repite solo:           │
│ el del año que viene habrá que revisarlo y confirmarlo.                   │
└───────────────────────────────────────────────────────────────────────────┘

> Corregido en step 16 (aviso D1). El mock decía «Horario de verano», con
> autoría y fecha de confirmación en pantalla, y el botón muerto de duplicado
> de temporada que la misión prohíbe reintroducir (§0 de
> (internal doc, not included in the template)). Los textos reales de `renderCalendario` no llevan
> autoría ni botón: ver la tabla de la §8.5 para el texto exacto y su
> procedencia en el código.

┌ CONTROLES ────────────────────────────────────────────────────────────────┐
│ [‹ Julio]   agosto de 2026   [Septiembre ›]        [+ Añadir día especial]│
└───────────────────────────────────────────────────────────────────────────┘

┌ REJILLA DEL MES ──────────────────────────────────────────────────────────┐
│  lun     mar     mié     jue     vie     sáb     dom                      │
│ ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┐                               │
│ │     │     │     │     │     │  1  │  2  │                               │
│ │     │     │     │     │     │09:00│Cerr.│                               │
│ │     │     │     │     │     │14:00│     │                               │
│ ├─────┼─────┼─────┼─────┼─────┼─────┼─────┤                               │
│ │  3  │  4  │  5  │  6  │  7  │  8  │  9  │                               │
│ │HOY  │09:00│09:00│09:00│09:00│09:00│Cerr.│                               │
│ │Cerr.│17:30│17:30│17:30│17:30│14:00│     │                               │
│ │  •3 │     │     │     │  •1 │     │     │                               │
│ ├─────┼─────┼─────┼─────┼─────┼─────┼─────┤                               │
│ │ 10  │ 11  │ 12  │ 13  │ 14  │ 15  │ 16  │                               │
│ │Cerr.│09:00│09:00│09:00│09:00│▲Fes-│Cerr.│                               │
│ │     │17:30│17:30│17:30│17:30│tivo │     │                               │
│ │     │ ◆Á  │ ◆Á  │ ◆Á  │     │Cerr.│     │                               │
│ └─────┴─────┴─────┴─────┴─────┴─────┴─────┘                               │
│                                                                           │
│ Leyenda:  Cerr. = cerrado   ▲ = festivo o día especial                    │
│           ◆ = alguien del equipo no está   • = número de citas            │
└───────────────────────────────────────────────────────────────────────────┘

┌ DÍAS DISTINTOS DE ESTE MES ───────────────────────────────────────────────┐
│ 15 de agosto  ▲ Festivo · Local cerrado · Aprobado    [Ver detalle]       │
│ 11–13 de ago  ◆ Álex (sintético) no está · Vacaciones [Ver detalle]       │
└───────────────────────────────────────────────────────────────────────────┘
```

Flujo **Añadir día especial** (diálogo modal, tres pasos en la misma ventana):

```
┌ Añadir un día especial ───────────────────────────── [✕] ─┐
│ PASO 1 de 3 · Qué quieres cambiar                         │
│ ( ) Cerrar el local unos días                             │
│ ( ) Abrir con un horario distinto un día                  │
│                                                           │
│ Desde  [ 2026-08-24 ]   Hasta  [ 2026-08-24 ]             │
│ Nombre para identificarlo  [ cierre-reforma        ]      │
│                                                           │
│                       [Cancelar]  [Ver qué citas afecta]  │
└───────────────────────────────────────────────────────────┘

┌ Añadir un día especial ───────────────────────────── [✕] ─┐
│ PASO 2 de 3 · Citas afectadas                             │
│                                                           │
│ Hay 2 citas dentro de esas fechas. Decide qué hacer con   │
│ cada una. Nada se cancela ni se mueve solo.               │
│                                                           │
│ ┌───────────────────────────────────────────────────────┐ │
│ │ 24 de agosto, 10:00 · Corte de pelo · Álex            │ │
│ │ ( ) Mantener la cita y marcarla para revisar          │ │
│ │ ( ) Avisar: que alguien llame al cliente              │ │
│ ├───────────────────────────────────────────────────────┤ │
│ │ 24 de agosto, 11:30 · Corte y barba · Dani            │ │
│ │ ( ) Mantener la cita y marcarla para revisar          │ │
│ │ ( ) Avisar: que alguien llame al cliente              │ │
│ └───────────────────────────────────────────────────────┘ │
│                                                           │
│ Falta decidir 2 citas.                                    │
│                  [Atrás]  [Cancelar]  [Guardar cambio]    │
└───────────────────────────────────────────────────────────┘
      (el botón "Guardar cambio" está deshabilitado
       hasta que las 2 estén decididas)

┌ Añadir un día especial ───────────────────────────── [✕] ─┐
│ PASO 3 de 3 · Hecho                                       │
│ ✓ Cambio guardado.                                        │
│ 1 cita se ha marcado para que alguien llame al cliente.   │
│ La tienes en "Cosas que hacer una persona".               │
│                                          [Cerrar]         │
└───────────────────────────────────────────────────────────┘
```

### 5.5 Equipo (`#/equipo`)

```
┌ CABECERA: Equipo ─────────────────────────────────────────────────────────┐

┌ AVISO ────────────────────────────────────────────────────────────────────┐
│ Las personas de esta lista son inventadas para la demostración. No         │
│ corresponden a nadie del equipo real de Demo Salon.                           │
└───────────────────────────────────────────────────────────────────────────┘

┌ HORARIO DEL LOCAL (una sola vez, arriba de las fichas) ───────────────────┐
│ Horario del local                                                         │
│ Estos siete días van con el horario de siempre del local. Es el mismo     │
│ para todo el equipo.                                                      │
│ Lunes 3 ago   Cerrado · Día de descanso                                   │
│ Martes 4 ago  09:00 – 17:30                                               │
│ ...                                                                       │
│ [Ver el calendario]                                                       │
└───────────────────────────────────────────────────────────────────────────┘

┌ FICHA POR PROFESIONAL (compacta, sin horario propio) ─────────────────────┐
│ ┌───────────────────────────────────────────────────────────────────────┐ │
│ │ Álex (sintético)                              [+ Añadir ausencia]     │ │
│ │ Puede hacer   Barba · Corte de pelo · Corte y barba                   │ │
│ │ Ausencias próximas                                                    │ │
│ │ [◆ Vacaciones · 11 – 13 de agosto de 2026 · Todo el día]              │ │
│ └───────────────────────────────────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────────────────────────────────┐ │
│ │ Nerea (sintética)                             [+ Añadir ausencia]     │ │
│ │ Puede hacer   Corte de pelo · Corte y barba                           │ │
│ │ Ausencias próximas   Sin ausencias apuntadas.                         │ │
│ └───────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

> Corregido en step 16 (aviso D1, extensión). Esta ficha llevaba un
> sub-bloque «Horario habitual» con horas propias por empleado (Álex
> 09:00-17:00 con descanso, Martes ídem…), que contradice la verdad de
> negocio: el horario es del local y es idéntico para todo el equipo (§1 de
> (internal doc, not included in the template)). La nota «step 15» de §8.6 más abajo ya avisaba de
> que esta parte del documento estaba desfasada; la FASE 3B de esta misión
> (O5) la resolvió de verdad: el horario sale **una vez**, arriba de las
> fichas, resuelto por fecha real con `resolveVenueDay(iso, snap.calendar)`
> dentro de la función `renderEquipo()` de `ui.js.ts`, y cada ficha se queda
> solo con lo propio de cada persona.

Flujo **Añadir ausencia**: mismo diálogo de 3 pasos que el calendario
(elegir → citas afectadas → hecho). Campos del paso 1:

```
Profesional  [ Álex (sintético)   ▾ ]
Motivo       ( ) Vacaciones  ( ) Ausencia  ( ) Formación
Desde        [ 2026-08-11 ]   Hasta [ 2026-08-13 ]
[x] Todo el día
Nombre para identificarlo  [ vacaciones-alex-ago ]
```

**[R]** El formulario **no** ofrece ningún campo de motivo privado, ni de notas.
`privateReason` no se recoge, no se envía y no se muestra. La clasificación
Vacaciones / Ausencia / Formación es lo único que se guarda y lo único que se
enseña, y ni siquiera eso sale nunca hacia un cliente.

### 5.6 Laboratorio (`#/laboratorio`)

```
┌ CABECERA: Laboratorio ────────────────────────────────────────────────────┐

┌ AVISO ────────────────────────────────────────────────────────────────────┐
│ Esta sección es para enseñar y depurar el motor. Lo que se ejecute aquí    │
│ aparecerá en el resto de la consola como si fueran llamadas reales de la   │
│ demostración.                                                             │
└───────────────────────────────────────────────────────────────────────────┘

┌ EJECUTAR UN ESCENARIO ────────────────────────────────────────────────────┐
│ Ejemplo         [ Reserva con un profesional concreto        ▾ ]          │
│ scenarioId      [ A20-console-reserva-concreta                 ]          │
│ callId (opc.)   [                                              ]          │
│ [x] Transferencia en vivo disponible                                      │
│ Turnos (JSON)                                                             │
│ ┌───────────────────────────────────────────────────────────────────────┐ │
│ │ [ { "utterance": "quiero reservar una cita", ... } ]                  │ │
│ └───────────────────────────────────────────────────────────────────────┘ │
│                                              [Ejecutar escenario]         │
│                                                                           │
│ Resultado                                                                 │
│ outcome: RESUELVE · Código congelado (reasonCode): BOOKING_CONFIRMED      │
│ Código interno (internalReasonCode): BOOKING_CONFIRMED ·                  │
│   announcesSuccess: true                                                  │
│ finalState: ...                                                           │
│ Frases devueltas: ...                                                     │
└───────────────────────────────────────────────────────────────────────────┘

┌ RECUENTO DE EVENTOS ──────────────────────────────────────────────────────┐
│ Flujo de piloto (congelado)        Flujo interno                          │
│ CALL_STARTED              7        AVAILABILITY_QUERIED          5        │
│ INTENT_CLASSIFIED         7        BOOKING_WRITTEN_SYNTHETIC     3        │
│ OUTCOME_EMITTED           7        INTERNAL_OUTCOME_RESOLVED     7        │
│ ...                               ...                                     │
│                                                                           │
│ Latencia de respuesta — No se mide en esta demostración.                  │
│ (PILOT_METRICS.md: no se recoge; no hay cifra que enseñar.)               │
└───────────────────────────────────────────────────────────────────────────┘

┌ HISTORIAL DE AUDITORÍA DEL CALENDARIO ────────────────────────────────────┐
│ • Cambio cierre de local 'cierre-reforma' (2026-08-24..2026-08-24)        │
│   publicado el 2026-08-02T09:00:00 por consola-operador (2 resoluciones…) │
└───────────────────────────────────────────────────────────────────────────┘

┌ INSTANTÁNEA EN CRUDO ─────────────────────────────────────────────────────┐
│ ▸ Ver el JSON de /api/snapshot                                            │
└───────────────────────────────────────────────────────────────────────────┘

┌ ZONA DESTRUCTIVA ─────────────────────────────────────────────────────────┐
│ Reiniciar la demostración                                                 │
│ Borra todas las llamadas, reservas, tareas, avisos, errores y cambios de  │
│ calendario de esta demostración.                                          │
│                                        [Reiniciar la demostración]        │
└───────────────────────────────────────────────────────────────────────────┘
```

El JSON crudo se pinta con `textContent = JSON.stringify(snap, null, 2)` dentro
de un `<pre>`. Sigue sin haber `innerHTML`.

---

## 6. Inventario de componentes

Nombres de clase definitivos. Prefijo `tx-` en todos.

### 6.1 `.tx-pill` — píldora de estado

**Para qué.** Traducir un resultado del motor a una de las seis palabras del
vocabulario llano (§7), con texto, símbolo y borde además del color.

**Estructura.**
```html
<span class="tx-pill tx-pill--ok">
  <span class="tx-pill__glyph" aria-hidden="true">✓</span>
  <span class="tx-pill__label">Reserva confirmada</span>
</span>
```

**Estados / modificadores.**

| Modificador | Etiqueta exacta | Glifo | Texto | Fondo | Borde |
| --- | --- | --- | --- | --- | --- |
| `--ok` | `Reserva confirmada` | `✓` | `--tx-green-700` | `--tx-green-50` | `1px solid --tx-green-700` |
| `--attention` | `Necesita revisión` | `!` | `--tx-amber-800` | `--tx-amber-50` | `1px dashed --tx-amber-800` |
| `--derived` | `Derivada a una persona` | `→` | `--tx-copper-700` | `--tx-copper-50` | `1px solid --tx-copper-700` + barra izq. 3 px |
| `--incomplete` | `No completada` | `○` | `--tx-neutral-700` | `--tx-neutral-50` | `1px dotted --tx-neutral-700` |
| `--error` | `Error técnico` | `✕` | `--tx-red-700` | `--tx-red-50` | `2px solid --tx-red-700` |
| `--none` | `Sin incidencias` | `—` | `--tx-neutral-700` | `transparent` | `1px solid --tx-line-strong` |

Estilo base: `--tx-radius-pill`, `padding: var(--tx-space-1) var(--tx-space-3)`,
`--tx-size-200`, `--tx-weight-semibold`, `display: inline-flex`,
`gap: var(--tx-space-2)`, `white-space: nowrap`.

Tamaño compacto `.tx-pill--sm` (`--tx-size-100`, `padding: 2px var(--tx-space-2)`)
sólo dentro de celdas de calendario.

### 6.2 `.tx-stat` — tarjeta de cifra

**Para qué.** Una sola cifra operativa, con su unidad de medida explícita y un
enlace a donde se puede actuar.

```html
<a class="tx-stat" href="#/llamadas">
  <span class="tx-stat__value">4 de 7</span>
  <span class="tx-stat__label">Resueltas sin molestar a nadie</span>
  <span class="tx-stat__hint">Ver llamadas</span>
</a>
```

**Estados.**
- *Normal*: fondo `--tx-surface`, borde fino, sombra 1.
- *Cero honesto*: cuando el denominador es 0, `__value` muestra `Sin datos
  todavía` en `--tx-size-500` (no 36 px) y `--tx-ink-500`. Nunca `0 %`.
- *Alerta*: `.tx-stat--alert` cuando la cifra es de errores y es > 0: la cifra
  pasa a `--tx-red-700` y aparece `border-left: 3px solid var(--tx-red-700)`.
- *Hover/foco*: borde a `--tx-line-strong`, sombra 2.
- Si no lleva enlace, es `<div>`, no `<a>`, y no tiene `__hint`.

Etiquetas exactas de las cuatro de Inicio: `Llamadas atendidas hoy`,
`Resueltas sin molestar a nadie`, `Reservas creadas hoy`, `Errores técnicos`.

### 6.3 `.tx-attention-card` — tarjeta de atención

**Para qué.** Una cosa concreta que Bruno debería mirar, con su motivo en
castellano llano y un único botón.

```html
<article class="tx-attention-card tx-attention-card--error">
  <span class="tx-pill tx-pill--error">…</span>
  <h3 class="tx-attention-card__title">Un fallo técnico pudo dejar una reserva
    escrita sin avisar al cliente.</h3>
  <p class="tx-attention-card__meta">Hoy a las 11:14</p>
  <a class="tx-btn tx-btn--secondary" href="#/llamadas/a3f1…">Ver la llamada</a>
</article>
```

**Estados.** `--error` (barra izq. 3 px roja), `--attention` (ámbar),
`--derived` (cobre). Sin variante verde: lo que va bien no es una tarjeta de
atención.

**Orden de prioridad en la lista** (fijo, no configurable):
1. Error técnico con reserva escrita.
2. Error técnico sin reserva.
3. Necesita revisión (`RECHAZA`).
4. Derivada a una persona.

### 6.4 `.tx-appt-row` — fila de cita

```
09:00 │ Corte de pelo │ Álex (sintético) │ ✓ Reserva confirmada │ [›]
```

**Estados.** `--past` (texto `--tx-ink-500`, símbolo `·` antes de la hora),
`--next` (la primera futura del día: `border-left: 3px solid --tx-copper-500` y
el texto `Siguiente` en `--tx-size-100` versalitas), `--cancelled` (etiqueta
`Cancelada`, hora tachada con `text-decoration: line-through`, y además el texto
`Cancelada`, para no depender del tachado).

Nunca muestra precio, ni teléfono, ni nombre de cliente (que además no existen
en los datos).

### 6.5 `.tx-call-row` — fila de llamada

```
12:31 │ Pedir cita │ ✓ Reserva confirmada │ Nada │ [›]
```

Columna 2 traduce la intención (§8.3). Columna 4 es **qué hay que hacer**, con
sólo cuatro valores posibles: `Nada`, `Revisar`, `Devolver la llamada`,
`Llamar al cliente`.

**Estados.** `--unread` no existe (no hay concepto de leído). `--selected`
cuando su detalle está abierto: fondo `--tx-surface-alt` + barra izquierda cobre.

### 6.6 `.tx-day-cell` — celda de día del calendario

```html
<td class="tx-day-cell tx-day-cell--today tx-day-cell--closed">
  <span class="tx-day-cell__number">3</span>
  <span class="tx-day-cell__today">Hoy</span>
  <span class="tx-day-cell__hours">Cerrado</span>
  <span class="tx-day-cell__marks">…</span>
</td>
```

**Estados y su portador no cromático:**

| Estado | Portador no cromático | Color |
| --- | --- | --- |
| `--today` | Texto `Hoy` + borde 2 px `--tx-ink-900` | — |
| `--closed` | Texto `Cerrado` | fondo `--tx-neutral-50` |
| `--holiday` | Glifo `▲` + texto `Festivo` | texto `--tx-amber-800` |
| `--special` | Glifo `▲` + horas especiales visibles | texto `--tx-copper-700` |
| `--absence` | Glifo `◆` + inicial del profesional | texto `--tx-copper-700` |
| `--has-bookings` | Glifo `•` + número de citas | `--tx-ink-500` |
| `--outside-month` | Celda vacía, `aria-hidden="true"` | — |

Alto mínimo 96 px, sin excepción por anchura: `.tx-day-cell` declara
`min-height: 96px` fuera de toda `@media`, así que el mínimo es el mismo a
1280 px, a 1024 px y por debajo. A ≤720 px la rejilla mensual
**se conserva**: pide `min-width: 640px` dentro de un contenedor
`.tx-table-scroll` con `overflow-x: auto` y `tabindex="0"`, y se recorre
desplazándola a lo ancho. Nunca se esconde ni se sustituye.

> Corregido en step 16 (aviso D1). Este párrafo afirmaba que la rejilla se
> sustituía por la lista de días distintos. Esa sustitución se eliminó en E3/D2
> de step 15 porque la lista de repuesto no la rellenaba ningún código y
> dejaba la vista Calendario literalmente sin calendario por debajo de 720 px.

> Corregido en step 16 (reparación B1, revisión adversarial). Este párrafo
> también afirmaba un alto mínimo de 72 px a 1024 px que no existe en el CSS
> servido (`.tx-day-cell` no tiene ninguna regla de `min-height` distinta de
> los 96 px de base) — la misma frase que ya se había corregido a medias más
> arriba, dejando este segundo error sin tocar.

### 6.7 `.tx-absence-chip` — etiqueta de ausencia

```html
<span class="tx-absence-chip tx-absence-chip--vacation">
  <span aria-hidden="true">◆</span>
  Vacaciones · 11 – 13 de agosto de 2026 · Todo el día
</span>
```

Tres variantes con su texto exacto: `Vacaciones`, `Ausencia`, `Formación`.
Diferenciadas además por glifo: `◆`, `◇`, `▣`.
**Nunca** contiene motivo, nota ni comentario. Si algún día `privateReason`
apareciera en la respuesta, este componente no tiene ranura donde ponerlo — es
deliberado.

### 6.8 `.tx-impact-table` — tabla de citas afectadas

**Para qué.** El paso obligatorio antes de publicar un cambio de calendario.

```
┌──────────────────────────────────────────────────────────────┐
│ CITA                        │ QUÉ HACEMOS CON ELLA           │
│ 24 de agosto, 10:00         │ ( ) Mantener y marcar          │
│ Corte de pelo · Álex        │ ( ) Avisar para llamar         │
└──────────────────────────────────────────────────────────────┘
```

**Estados.**
- *Sin impacto*: no se muestra la tabla; en su lugar el vacío
  `No hay ninguna cita afectada. Puedes guardar el cambio.` y el botón
  `Guardar cambio` habilitado.
- *Pendiente*: contador vivo `Falta decidir N citas.`; botón deshabilitado con
  `aria-disabled="true"` y `title` explicativo.
- *Completa*: `Todas las citas están decididas.`; botón habilitado.
- *Rechazo del servidor (409)*: `No se ha guardado: han cambiado las citas
  afectadas. Vuelve a revisarlas.` y se re-pide la vista previa automáticamente.

Etiquetas exactas de las dos resoluciones (mapean a `keep_and_flag` y
`mark_for_human_contact`):
- `Mantener la cita y marcarla para revisar`
- `Avisar: que alguien llame al cliente`

### 6.9 `.tx-empty` — estado vacío

```html
<div class="tx-empty">
  <p class="tx-empty__title">Todo tranquilo.</p>
  <p class="tx-empty__body">No hay nada que necesite tu atención ahora mismo.</p>
</div>
```

Nunca ilustración, nunca icono grande, nunca "¡Enhorabuena!". Fondo
`--tx-surface`, borde discontinuo `1px dashed var(--tx-line-strong)`, texto
centrado, `padding: var(--tx-space-8)`. Todos los textos vacíos están en §8.

### 6.10 `.tx-dialog` — diálogo de confirmación

Elemento nativo `<dialog>` + `showModal()`. Motivo: la trampa de foco, el cierre
con `Escape` y el `::backdrop` los da el navegador, sin una línea de JS de
accesibilidad que se pueda implementar mal y sin ningún estilo en línea.

```html
<dialog class="tx-dialog" id="dialogo-reset" aria-labelledby="dialogo-reset-titulo">
  <h2 class="tx-dialog__title" id="dialogo-reset-titulo">…</h2>
  <p class="tx-dialog__body">…</p>
  <div class="tx-dialog__actions">
    <button class="tx-btn tx-btn--ghost" value="cancel">Cancelar</button>
    <button class="tx-btn tx-btn--danger" value="confirm">…</button>
  </div>
</dialog>
```

**Estados.** *Cerrado* / *abierto* / *en curso* (botón de confirmación
deshabilitado con texto `Guardando…`) / *error* (mensaje en `role="alert"`
dentro del diálogo, el diálogo **no** se cierra).

El botón destructivo es siempre el **último** y **nunca** el que tiene el foco
inicial: el foco inicial va al título (`tabindex="-1"`).

### 6.11 `.tx-btn` — botón

| Variante | Uso | Fondo | Texto | Borde |
| --- | --- | --- | --- | --- |
| `--primary` | Acción principal de un formulario | `--tx-copper-700` | `#FFFFFF` (6.33:1) | ninguno |
| `--secondary` | Navegar a un detalle | `--tx-surface` | `--tx-ink-900` | `--tx-border-control` |
| `--ghost` | Cancelar, cerrar | `transparent` | `--tx-ink-700` | ninguno |
| `--danger` | Sólo reiniciar la demostración | `--tx-red-700` | `#FFFFFF` (6.54:1) | ninguno |

Alto mínimo 44 px en acciones principales, 36 px en acciones de fila (con 8 px de
separación, cumple el mínimo de 24×24 de WCAG 2.2 AA). Deshabilitado:
`opacity: .55` + `cursor: not-allowed` + `aria-disabled="true"`, y **siempre** un
texto que explique por qué (nunca un botón muerto y mudo).

> ***Enmendado 2026-08-05 tras revisión adversarial de la capacidad 3,
> hallazgo M6.*** *La casa usa `disabled` NATIVO en los nueve botones que hoy
> se deshabilitan (incluido `#huecos-comprobar`, capacidad 1), no
> `aria-disabled="true"` como dice el párrafo de arriba — desviación real,
> ya presente antes de esta misión y ahora también en el control nuevo, sin
> declarar hasta hoy. La razón es la de (internal doc, not included in the template) (apartado
> «E4», líneas 113-116): un botón con `aria-disabled` pero SIN `disabled` real se puede
> enfocar y pulsar sin que pase nada — «un control muerto que se puede pulsar
> es peor que ningún control». Con `disabled` de verdad el botón no es
> focalizable, así que su `aria-describedby` nunca se lee — la explicación de
> por qué está apagado viaja en su lugar por la línea visible en el orden de
> lectura (p. ej. `#huecos-gate`), nunca sólo por el atributo. Cambiar los
> nueve controles a `aria-disabled` + guarda de manejador es una misión
> aparte, no una reparación de plumbing.*

### 6.12 `.tx-brand__glyph` — glifo "TX"

**Para qué.** Los sitios donde el logotipo de 400×400 no se lee: barra lateral
colapsada a 76 px y favicon.

- Es **texto**: `TX` en `--tx-font-sans`, `--tx-weight-bold`,
  `letter-spacing: -0.02em`, `--tx-sidebar-text` sobre una placa
  `--tx-surface`… no: en el raíl colapsado la placa clara de 76 px es
  demasiado pesada, así que aquí el glifo va **sobre el propio fondo oscuro**,
  en `--tx-copper-200` (8.67:1), dentro de un cuadrado de 40 × 40 px con
  `border: 1px solid var(--tx-copper-500)` y `--tx-radius-sm`.
- **[R]** Es un elemento de interfaz, no una versión del logotipo. En ningún
  sitio se presenta como marca oficial ni sustituye al PNG cuando éste cabe.
  Así lo fija (internal doc, not included in the template).
- Favicon: fichero `favicon.svg` generado con ese mismo glifo (texto SVG, tinta
  `#171615` sobre `#F5F1E8`, sin fuente externa: `font-family="system-ui"`).
  Requiere `img-src 'self'` (Anexo A.2).

### 6.13 Componentes de apoyo

- `.tx-panel` — contenedor de sección con `<h2>`; borde fino, sin sombra.
- `.tx-table` — tabla base con `<caption class="tx-visually-hidden">` obligatorio
  y `scope="col"` en cada `<th>`.
- `.tx-table-scroll` — envoltorio desplazable, `tabindex="0"`, `role="region"`,
  `aria-label` propio.
- `.tx-details` — `<details>`/`<summary>` de "Detalle técnico"; `<summary>` con
  44 px de alto y marcador `▸`/`▾`.
- `.tx-status-line` — `role="status"`, `aria-live="polite"`; **una sola** por
  vista, para resultados de acción (§9.5).
- `.tx-visually-hidden` — patrón estándar (clip 1×1 px), nunca `display: none`.

---

## 7. Vocabulario de estado: la tabla de traducción

**[R]** Estas seis palabras son las únicas que ve Bruno. Se implementan en **un
único sitio** — un mapa constante dentro de `ui.js.ts` — y ninguna vista
construye su propia etiqueta.

### 7.1 La regla de derivación (en este orden)

```
1. outcome === "RESUELVE" && countsAsBookingConversion  → Reserva confirmada
2. outcome === "RESUELVE"                               → Sin incidencias
3. internalReasonCode === "TECHNICAL_FAILURE"           → Error técnico
4. outcome === "RECHAZA"                                → Necesita revisión
5. internalReasonCode === "BOOKING_NOT_CONFIRMED"       → No completada
6. outcome === "DERIVA"                                 → Derivada a una persona
```

Se lee **`internalReasonCode`**, nunca el `reasonCode` congelado, tal y como
obliga `PILOT_METRICS.md` y el docblock de `outcomeDimension.ts`. Si un día
`internalReasonCode` no viniera, se cae a `reasonCode` y se registra en el
detalle técnico que se usó el código congelado — pero **nunca** se inventa un
estado bonito por defecto.

### 7.2 La tabla completa

| `internalReasonCode` | `outcome` | Etiqueta en castellano | Modificador | Token de color | Glifo | Otro portador no cromático |
| --- | --- | --- | --- | --- | --- | --- |
| `BOOKING_CONFIRMED` | `RESUELVE` | **Reserva confirmada** | `--ok` | `--tx-green-700` / `--tx-green-50` | `✓` | Borde continuo + texto |
| `AVAILABILITY_PROVIDED` | `RESUELVE` | **Sin incidencias** | `--none` | `--tx-neutral-700` | `—` | Sin relleno, borde neutro |
| `TECHNICAL_FAILURE` | `DERIVA` | **Error técnico** | `--error` | `--tx-red-700` / `--tx-red-50` | `✕` | Borde de **2 px** (el más grueso) |
| `SECURITY_OR_PRIVACY_BOUNDARY` | `RECHAZA` | **Necesita revisión** | `--attention` | `--tx-amber-800` / `--tx-amber-50` | `!` | Borde **discontinuo** |
| `BOOKING_NOT_CONFIRMED` | `DERIVA` | **No completada** | `--incomplete` | `--tx-neutral-700` / `--tx-neutral-50` | `○` | Borde **punteado** |
| `CUSTOMER_REQUESTS_HUMAN` | `DERIVA` | **Derivada a una persona** | `--derived` | `--tx-copper-700` / `--tx-copper-50` | `→` | Barra izquierda de 3 px |
| `CANCEL_OR_CHANGE_NOT_ENABLED` | `DERIVA` | **Derivada a una persona** | `--derived` | ídem | `→` | ídem |
| `BUSINESS_DATA_NOT_APPROVED` | `DERIVA` | **Derivada a una persona** | `--derived` | ídem | `→` | ídem |
| `SLOT_OUTSIDE_SYNTHETIC_SCHEDULE` | `DERIVA` | **Derivada a una persona** | `--derived` | ídem | `→` | ídem |
| `SERVICE_NOT_CONFIRMED` | `DERIVA` | **Derivada a una persona** | `--derived` | ídem | `→` | ídem |
| `INTENT_NOT_UNDERSTOOD` | `DERIVA` | **Derivada a una persona** | `--derived` | ídem | `→` | ídem |

### 7.3 Estados que no vienen de una llamada

| Origen | Etiqueta | Modificador |
| --- | --- | --- |
| Reserva sintética `status: "confirmed"` | **Reserva confirmada** | `--ok` |
| Reserva sintética `status: "cancelled"` | **Cancelada** (fuera del vocabulario de llamadas; sólo en agenda) | `--incomplete` |
| Llamada con `requiresOperatorReview === true` | insignia extra `Reserva pendiente de comprobar` junto a la píldora principal | `--attention` |
| Sondeo caído > 6 s | **Sin conexión con el motor** en `.tx-freshness` | `--error` |
| Día sin citas, sin errores y sin cola | **Sin incidencias** en el resumen del día | `--none` |

### 7.4 Cuatro decisiones que conviene no reabrir

1. **`AVAILABILITY_PROVIDED` → "Sin incidencias", no "Reserva confirmada".** Es
   `RESUELVE` y `countsAsContained: true`, pero **no** creó reserva
   (`countsAsBookingConversion: false`). Llamarlo "confirmada" sería exactamente
   la falsa confirmación que `PILOT_METRICS.md` prohíbe.
2. **`BOOKING_NOT_CONFIRMED` → "No completada", y no cuenta como resuelta.**
   `countsAsContained: false` está razonado en `outcomeDimension.ts:204-233`. La
   interfaz respeta esa decisión: esa llamada **no** suma en "Resueltas sin
   molestar a nadie". Contarla inflaría el titular con llamadas que no
   resolvieron nada.
3. **`SECURITY_OR_PRIVACY_BOUNDARY` → "Necesita revisión".** El asistente hizo lo
   correcto al rechazar, pero que alguien intente acceder a datos de otro es
   justo el tipo de cosa que el dueño quiere ver. Va a la cola de atención, no al
   silencio.
4. **Error técnico gana a necesita revisión.** Cuando `requiresOperatorReview` es
   `true` sobre un `TECHNICAL_FAILURE`, la píldora dice `Error técnico` (la
   severidad mayor manda) y se añade la insignia
   `Reserva pendiente de comprobar`. Nunca se degrada un error a aviso.

---

## 8. Copy deck

Todo lo que ve un ser humano. Castellano de España, tuteo, frases cortas. Ni una
sola palabra técnica fuera de Laboratorio y de los bloques `Detalle técnico`.

### 8.1 Estructura general

| Sitio | Texto exacto |
| --- | --- |
| `<title>` base | `Demo Salon — Consola de operación` |
| `<title>` por vista | `Inicio · Demo Salon` / `Agenda · Demo Salon` / `Llamadas · Demo Salon` / `Calendario · Demo Salon` / `Equipo · Demo Salon` / `Laboratorio · Demo Salon` |
| Enlace de salto | `Saltar al contenido principal` |
| Marca (alt) | `Demo Salon Barbershop` |
| Subtítulo de marca | `Consola de operación` |
| Insignia obligatoria | `Demo local · Datos sintéticos · No producción` |
| Rótulo de navegación | `Secciones de la consola` |
| Grupo de herramientas | `HERRAMIENTAS DE DEMOSTRACIÓN` |
| Pie de la barra lateral | `Local · 127.0.0.1:4310` |
| Frescura (normal) | `Actualizado a las {HH:mm:ss}` |
| Frescura (caída) | `Sin conexión con el motor` |
| Frescura (primera carga) | `Cargando…` |
| Nombres de sección | `Inicio` · `Agenda` · `Llamadas` · `Calendario` · `Equipo` · `Laboratorio` |

### 8.2 Inicio

| Elemento | Texto exacto |
| --- | --- |
| H1 | `Inicio` |
| Fecha | `{lunes}, {3} de {agosto} de {2026}` |
| Estado del asistente (bien) | `Asistente sintético · Respondiendo` |
| Estado del asistente (mal) | `Asistente sintético · Sin respuesta` |
| Nota de contexto | `Estos datos son de una demostración local. No hay ninguna línea telefónica conectada y no se toca ningún sistema real de Demo Salon.` |
| KPI 1 | `Llamadas atendidas hoy` |
| KPI 1 (pie) | `Simuladas` |
| KPI 2 | `Resueltas sin molestar a nadie` |
| KPI 2 (formato) | `{n} de {N}` |
| KPI 2 (pie) | `Ver llamadas` |
| KPI 3 | `Reservas creadas hoy` |
| KPI 3 (pie) | `Ver agenda` |
| KPI 4 | `Errores técnicos` |
| KPI 4 (pie, si > 0) | `Ver detalle` |
| KPI sin datos | `Sin datos todavía` |
| H2 atención | `Necesita tu atención` |
| H2 cola | `Cosas que hacer una persona` |
| H2 citas | `Próximas citas de hoy` |
| H2 excepciones | `Próximos días distintos` |
| H2 actividad | `Lo último que ha pasado` |
| Enlace agenda | `Ver toda la agenda` |
| Enlace llamadas | `Ver todas las llamadas` |
| Enlace calendario | `Ver el calendario` |

> Corregido en step 16 (reparación adversarial, 2ª ronda, F1). Esta tabla
> traía una fila `Contexto` con la línea que abría el panel de contexto de
> Inicio: el nombre del local seguido del subtítulo de marca. La FASE 3A
> **borró esa línea del HTML** (commit `f275880`) porque la identidad ya la
> lleva el logotipo con su `alt`, y no respondía a ninguna de las cinco
> preguntas que esa fase quería resolver por encima del pliegue. La fila
> se ha quitado en vez de dejarla describiendo un texto que ya no existe.

**Vacíos de Inicio.**

| Bloque | Título | Cuerpo |
| --- | --- | --- |
| Atención | `Todo tranquilo.` | `No hay nada que necesite tu atención ahora mismo.` |
| Cola humana | `Nada pendiente.` | `Ninguna llamada ha quedado esperando a una persona.` |
| Citas de hoy | `No quedan citas hoy.` | `No hay ninguna cita más en lo que queda de día.` |
| Actividad | `Todavía no ha pasado nada.` | `Cuando el asistente atienda una llamada, aparecerá aquí.` |

> Corregido en step 16 (reparación adversarial, 2ª ronda, F1). Esta tabla
> traía una fila `Días distintos` con el título y el cuerpo de la tarjeta
> vacía de dos párrafos que la FASE 3A **eliminó** (commit `f275880`) al
> sustituir "Próximos días distintos" por el resumen compacto de una línea
> que se documenta justo debajo. No es un vacío de título+cuerpo: es un único
> párrafo (`#inicio-calendario-resumen` en `ui.html.ts`) que se pinta
> siempre, tenga o no excepciones por delante.

**Resumen compacto de "Próximos días distintos" (`#inicio-calendario-resumen`).**

Un único párrafo, régimen + recuento, tomado literalmente de `renderInicio`
(`ui.js.ts`, entorno de la función `countDistinctCalendarDays`). El recuento
es de **días naturales**, no de entradas del calendario: un cierre de dos
días cuenta como dos días, no como una excepción.

| Régimen | Recuento | Texto exacto |
| --- | --- | --- |
| Sin temporada activa | 0 | `El local va con su horario de siempre. No hay ningún día distinto por delante.` |
| Sin temporada activa | 1 | `El local va con su horario de siempre. Hay 1 día distinto por delante.` |
| Sin temporada activa | N (> 1) | `El local va con su horario de siempre. Hay N días distintos por delante.` |
| Con temporada activa | 0 | `El local va con el horario de temporada («{etiqueta}», {rango}). No hay ningún día distinto por delante.` |
| Con temporada activa | N | `El local va con el horario de temporada («{etiqueta}», {rango}). Hay N días distintos (o "1 día distinto") por delante.` |

**Textos de las tarjetas de atención.**

| Caso | Título | Botón |
| --- | --- | --- |
| Fallo técnico con reserva escrita | `Un fallo técnico pudo dejar una reserva escrita sin avisar al cliente.` | `Ver la llamada` |
| Fallo técnico sin reserva | `Una llamada se cortó por un fallo técnico.` | `Ver la llamada` |
| Rechazo por privacidad | `Se bloqueó una petición por privacidad.` | `Ver la llamada` |
| Derivada a una persona | `El cliente pidió hablar con alguien del equipo.` | `Ver la llamada` |
| Derivada por otro motivo | `El asistente no pudo resolverlo y lo dejó para una persona.` | `Ver la llamada` |

**Textos de la cola humana** (traducción de `HumanTask.reason`, §8.6).

| Origen | Título |
| --- | --- |
| `reason` con forma `A\d\d-…` (derivación de llamada) | `Devolver la llamada` |
| `REVIEW_ORPHANED_SYNTHETIC_RESERVATION` | `Comprobar una reserva que quedó sin avisar` |
| `CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE` | `Llamar al cliente por un cambio de calendario` |
| Cualquier otro valor | `Revisar esta llamada` |

Aviso interno simulado (`humanQueue.notices`): `Aviso interno simulado por
WhatsApp` / `Aviso interno simulado`. Va sólo en Llamadas y Laboratorio, no en
Inicio: no es una acción de Bruno.

### 8.3 Llamadas

| Elemento | Texto exacto |
| --- | --- |
| H1 | `Llamadas` |
| Filtros | `Todas ({n})` · `Necesitan atención ({n})` · `Con reserva ({n})` · `Derivadas ({n})` · `Con error ({n})` |
| Cabeceras de tabla | `Hora` · `Qué pedía` · `Resultado` · `Qué hay que hacer` |
| Acciones de la última columna | `Nada` · `Revisar` · `Devolver la llamada` · `Llamar al cliente` |
| Botón de fila | `Ver` (con `aria-label="Ver el detalle de la llamada de las {HH:mm}"`) |
| Vacío general | `Todavía no hay llamadas.` / `Cuando el asistente atienda una llamada de la demostración, aparecerá aquí.` |
| Vacío con filtro | `Ninguna llamada en este filtro.` / `Prueba con "Todas".` |

**Traducción de la intención (`lastIntent`) a "Qué pedía".**

| `PilotIntent` | Texto |
| --- | --- |
| `BOOK` | `Pedir cita` |
| `CHECK_AVAILABILITY` | `Consultar horas` |
| `HUMAN_HELP` | `Hablar con alguien` |
| `CANCEL` | `Anular una cita` |
| `RESCHEDULE` | `Cambiar una cita` |
| `ASK_PRICE` | `Preguntar un precio` |
| `OTHER` | `Otra cosa` |
| ausente | `Sin determinar` |

*(Nota: `Preguntar un precio` describe lo que pidió el cliente. La consola sigue
sin mostrar ningún importe.)*

**Panel de detalle.**

| Elemento | Texto exacto |
| --- | --- |
| Título | `Llamada de las {HH:mm}` |
| Cerrar | `Cerrar` |
| H3 | `Qué pasó` |
| H3 | `Lo que pidió el cliente` |
| H3 | `¿Se dijo al cliente que estaba confirmada?` (respuesta `Sí` / `No`) |
| Insignia | `Reserva pendiente de comprobar` |
| Enlace | `Ver la cita en la agenda` |
| Plegable | `Detalle técnico` |
| Botón | `Copiar el identificador` → tras copiar: `Copiado` |

**Explicaciones de "Qué pasó"** (una por etiqueta):

| Etiqueta | Texto |
| --- | --- |
| Reserva confirmada | `El asistente entendió lo que quería el cliente y dejó la cita reservada.` |
| Sin incidencias | `El asistente le dio las horas libres que pedía. No hacía falta reservar nada.` |
| No completada | `Se entendió lo que quería y había hueco, pero el cliente no llegó a confirmar la cita. No se ha reservado nada.` |
| Derivada a una persona | `El asistente no podía resolverlo por su cuenta y lo dejó para una persona del equipo.` |
| Necesita revisión | `El asistente rechazó la petición para proteger datos de otra persona. No dio ninguna información.` |
| Error técnico | `El asistente falló mientras gestionaba la llamada. No le dijo al cliente que la cita estuviera confirmada.` |

Texto de la insignia de reserva huérfana, completo:
`Se escribió una reserva sintética antes del fallo. Hay que comprobar si esa
cita sigue siendo válida.`

### 8.4 Agenda

| Elemento | Texto exacto |
| --- | --- |
| H1 | `Agenda` |
| Filtros | `Hoy` · `Mañana` · `Próximos 7 días` |
| Filtro de profesional | `Profesional` / opción `Todos` |
| Encabezado de día | `{lunes}, {3} de {agosto} de {2026}` |
| Horario del día | `Horario del local: {09:00} – {17:30}` |
| Día cerrado | `Local cerrado` |
| Día cerrado (motivo) | `Festivo aprobado` · `Cierre del local` · `Día de descanso` |
| Separador | `ya pasadas` |
| Cabeceras | `Hora` · `Servicio` · `Profesional` · `Estado` |
| Marca de la siguiente | `SIGUIENTE` |
| Vacío del día | `No hay ninguna cita este día.` |
| Vacío general | `No hay ninguna cita en estas fechas.` / `Las citas que cree el asistente aparecerán aquí.` |
| Duración en detalle | `{09:00} – {09:30} · 30 minutos` |

### 8.5 Calendario

| Elemento | Texto exacto |
| --- | --- |
| H1 | `Calendario` |
| Navegación de mes | `Mes anterior` / `Mes siguiente` (`aria-label` completo: `Ir a julio de 2026`) |
| Título del mes | `agosto de 2026` |
| Días de la semana | `lun` `mar` `mié` `jue` `vie` `sáb` `dom` (con `abbr` a `lunes`, …) |
| Botón principal | `Añadir día especial` |
| H2 leyenda | `Leyenda` |
| Leyenda | `Cerrado` · `Festivo o día especial` · `Alguien del equipo no está` · `Número de citas` |
| H2 lista | `Días distintos de este mes` |
| Vacío de la lista | `Este mes no tiene ningún día distinto.` / `Todos los días siguen el horario habitual.` |
| Celda de hoy | `Hoy` |
| Celda cerrada | `Cerrado` |

**Aviso de horario de temporada (agosto).**

| Elemento | Texto exacto |
| --- | --- |
| Título | `Horario de agosto de 2026 · del 1 al 31 de agosto` |
| Detalle | `Martes 09:00-17:30. Miércoles 09:00-17:30. Jueves 09:00-17:30. Viernes 09:00-17:30. Sábados 09:00-14:00. Cerrado: domingos, lunes.` |
| Aviso de fecha | `Este horario solo está confirmado para 2026. No se repite solo: el del año que viene habrá que revisarlo y confirmarlo.` |
| Nota estática | `Duplicar esta temporada para otro año todavía no se hace desde esta pantalla.` |

> Corregido en step 16 (aviso D1). Esta tabla describía el botón muerto de
> duplicado de temporada (el mismo que se cita en el §0 de
> (internal doc, not included in the template) como prohibido de reintroducir) y sus dos textos de
> confirmación («Estado sin confirmar», «Confirmación de duplicado»), además
> de una fila de «Autoría» que ya no se pinta (el comentario que precede a la
> asignación de `calendario-temporada-aviso-fecha`, dentro de `renderCalendario()`
> en `ui.js.ts`, explica por qué: era lenguaje interno y una fecha en crudo en
> pantalla de operador). El botón se eliminó en E4 de step 15 por ser un
> control muerto; los textos de «Título», «Detalle» y «Aviso de fecha» de
> arriba también estaban desfasados respecto a `renderCalendario()` (los
> nodos `calendario-temporada-titulo`, `calendario-temporada-detalle` y
> `calendario-temporada-aviso-fecha` en `ui.js.ts`) y se han sustituido por
> los reales.

**Diálogo "Añadir día especial".**

| Elemento | Texto exacto |
| --- | --- |
| Título | `Añadir un día especial` |
| Paso 1 | `Paso 1 de 3 · Qué quieres cambiar` |
| Opción A | `Cerrar el local unos días` |
| Opción B | `Abrir con un horario distinto un día` |
| Campos | `Desde` · `Hasta` · `Fecha` · `Abre a las` · `Cierra a las` · `Nombre para identificarlo` |
| Ayuda del nombre | `Sirve sólo para reconocerlo en la lista. Por ejemplo: cierre-reforma.` |
| Botón siguiente | `Ver qué citas afecta` |
| Paso 2 | `Paso 2 de 3 · Citas afectadas` |
| Intro con impacto | `Hay {n} citas dentro de esas fechas. Decide qué hacer con cada una. Nada se cancela ni se mueve solo.` |
| Intro sin impacto | `No hay ninguna cita afectada. Puedes guardar el cambio.` |
| Resolución A | `Mantener la cita y marcarla para revisar` |
| Resolución B | `Avisar: que alguien llame al cliente` |
| Contador | `Falta decidir {n} citas.` / `Falta decidir 1 cita.` / `Todas las citas están decididas.` |
| Botones | `Atrás` · `Cancelar` · `Guardar cambio` |
| Paso 3 | `Paso 3 de 3 · Hecho` |
| Éxito | `Cambio guardado.` |
| Éxito con avisos | `{n} citas se han marcado para que alguien llame al cliente. Las tienes en "Cosas que hacer una persona".` |
| Cerrar | `Cerrar` |

**Errores del diálogo.**

| Caso | Texto exacto |
| --- | --- |
| Faltan campos | `Rellena las fechas y el nombre antes de continuar.` |
| Fechas al revés | `La fecha de fin no puede ser anterior a la de inicio.` |
| Hora mal escrita | `Escribe la hora como HH:mm. Por ejemplo, 09:30.` |
| Vista previa rechazada | `No se ha podido calcular el impacto. Revisa las fechas.` |
| Publicación rechazada (409) | `No se ha guardado: han cambiado las citas afectadas. Vuelve a revisarlas.` |
| Fallo de red | `No hay conexión con el motor. No se ha guardado nada.` |
| En curso | `Guardando…` |

### 8.6 Equipo

| Elemento | Texto exacto |
| --- | --- |
| H1 | `Equipo` |
| Aviso | `Las personas de esta lista son inventadas para la demostración. No corresponden a nadie del equipo real de Demo Salon.` |
| H2 horario del local | `Horario del local` (una sola vez, arriba de las fichas) |
| Régimen, sin temporada | `Estos siete días van con el horario de siempre del local. Es el mismo para todo el equipo.` |
| Régimen, con temporada | `Estos siete días van con el horario de temporada del local («{etiqueta}», {rango}). Es el mismo para todo el equipo.` |
| Régimen, cruza frontera | `Atención: estos siete días cambian de horario por el camino. Unos van con el horario de siempre del local y otros con el de temporada {etiquetas}. Cada día de arriba lleva ya sus horas exactas. El horario es el mismo para todo el equipo.` |
| Fila de día (abierto) | `{Lunes} {4 ago}` / `{09:00} – {17:30}` |
| Fila de día (cerrado) | `{Lunes} {3 ago}` / `Cerrado · {Día de descanso\|Cierre del local\|Festivo aprobado}` |
| Enlace | `Ver el calendario` |
| H3 por ficha | (el `label` del profesional, ya con marcador `(sintético)`/`(sintética)`) |
| Sub-bloque | `Puede hacer` |
| Sub-bloque | `Ausencias próximas` |
| Vacío de ausencias | `Sin ausencias apuntadas.` |
| Botón | `Añadir ausencia` |
| Vacío general | `No hay ningún profesional en el calendario.` |

> Corregido en step 16 (aviso D1, extensión). Esta tabla describía
> «Horario habitual», una etiqueta de capacidades más larga que la actual
> («Puede hacer») y filas de horario propias por empleado dentro de cada
> ficha, y llevaba una nota step 15 que avisaba
> de que ya estaba desfasada sin llegar a corregirla. La FASE 3B de esta
> misión (aviso O5) implementó la solución que esa nota predecía —el horario
> sale una sola vez, arriba— con un texto de régimen distinto del que la nota
> proponía; la tabla de arriba es la real, tomada de la sección
> `id="tit-equipo-horario"` ("Horario del local") en `ui.html.ts` y de la
> función `renderEquipo()` en `ui.js.ts`. (internal doc, not included in the template) conserva
> el porqué del cambio de modelo; (internal doc, not included in the template) documenta O5.

**Diálogo "Añadir ausencia"** (mismos 3 pasos y mismos textos de impacto).

| Elemento | Texto exacto |
| --- | --- |
| Título | `Añadir una ausencia` |
| Campos | `Profesional` · `Motivo` · `Desde` · `Hasta` · `Todo el día` · `Nombre para identificarlo` |
| Opciones de motivo | `Vacaciones` · `Ausencia` · `Formación` |
| Nota de privacidad | `Sólo se guarda el tipo de ausencia. Ningún cliente verá nunca por qué falta alguien.` |
| Horas (si no es todo el día) | `Desde las` · `Hasta las` |

### 8.7 Laboratorio

| Elemento | Texto exacto |
| --- | --- |
| H1 | `Laboratorio` |
| Aviso | `Esta sección es para enseñar y depurar el motor. Lo que se ejecute aquí aparecerá en el resto de la consola como si fueran llamadas reales de la demostración.` |
| H2 | `Ejecutar un escenario` |
| Campos | `Ejemplo` · `Identificador de escenario` · `Identificador de llamada (opcional)` · `Transferencia en vivo disponible` · `Turnos (JSON)` |
| Marcador del selector | `(elige un ejemplo para cargarlo)` |
| Botón | `Ejecutar escenario` |
| Ayuda del id | `Tiene que empezar por A y dos cifras. Por ejemplo: A20-mi-escenario.` |
| Error de JSON | `Los turnos no son JSON válido.` |
| Error del servidor | `El motor ha rechazado el escenario: {mensaje}` |
| Error de red | `No hay conexión con el motor.` |
| H2 | `Resultado del escenario` |
| H2 | `Recuento de eventos` |
| Sub-h3 | `Flujo de piloto (congelado)` · `Flujo interno` |
| Nota de latencia | `Latencia de respuesta — No se mide en esta demostración.` |
| Nota de latencia (2ª línea) | `El motor no emite ninguna medida de latencia y no se inventa ninguna. Se medirá cuando exista una pasarela telefónica real.` |
| H2 | `Historial de auditoría del calendario` |
| Vacío de auditoría | `Todavía no se ha publicado ningún cambio de calendario.` |
| H2 | `Instantánea en crudo` |
| Plegable | `Ver el JSON de /api/snapshot` |
| H2 | `Zona destructiva` |
| Descripción | `Borra todas las llamadas, reservas, tareas, avisos, errores y cambios de calendario de esta demostración.` |
| Botón | `Reiniciar la demostración` |

**Diálogo de confirmación del reinicio destructivo** (texto exacto y completo):

| Elemento | Texto exacto |
| --- | --- |
| Título | `¿Seguro que quieres reiniciar la demostración?` |
| Cuerpo | `Se va a borrar todo el estado sintético: las llamadas, las reservas, las tareas pendientes, los avisos, los errores y los cambios de calendario que hayas publicado.` |
| Cuerpo (2ª línea) | `Esto no se puede deshacer.` |
| Tranquilizador | `No afecta a ningún sistema real de Demo Salon: aquí no hay nada real.` |
| Botón destructivo | `Sí, reiniciar la demostración` |
| Botón de escape | `Cancelar` |
| En curso | `Reiniciando…` |
| Éxito (en `role="status"`) | `Demostración reiniciada. Todo vuelve a estar a cero.` |
| Error | `No se ha podido reiniciar. Vuelve a intentarlo.` |

### 8.8 Textos comunes de error y de sistema

| Caso | Texto exacto |
| --- | --- |
| Sondeo caído | `Sin conexión con el motor. Lo que ves puede estar desactualizado.` |
| Sondeo recuperado | `Conexión recuperada.` |
| Ruta desconocida (`#/loquesea`) | `Esa página no existe.` / `Vuelve a Inicio desde el menú de la izquierda.` |
| Detalle no encontrado | `Esa llamada ya no está en la demostración.` / `Puede que se haya reiniciado.` |
| Genérico de red | `No hay conexión con el motor.` |
| Genérico de servidor | `El motor ha rechazado la petición.` |
| Fecha sin datos | `Sin fecha` |
| Valor ausente en una celda | `—` |

### 8.9 Reglas de redacción

- Tuteo siempre. Nunca "usted", nunca "el usuario".
- Nada de signos de exclamación. Nada de emojis en la interfaz.
- Nunca "sistema", "backend", "endpoint", "payload", "log" fuera de Laboratorio.
- Números de 0 a 9 en cifras cuando son datos (`3 citas`), porque se escanean
  mejor en una tabla.
- Fechas largas en castellano y en minúscula: `lunes, 3 de agosto de 2026`.
- Horas siempre en 24 h con dos cifras: `09:30`, nunca `9:30`.
- **[R] Nunca aparece un importe, un símbolo de euro ni la palabra "precio"
  fuera de la traducción de la intención `ASK_PRICE`.**

---

## 9. Accesibilidad

Objetivo: **WCAG 2.2 nivel AA**.

### 9.1 Foco

```css
:focus-visible {
  outline: var(--tx-focus-ring) solid var(--tx-focus-dark);
  outline-offset: var(--tx-focus-offset);
  box-shadow: var(--tx-focus-halo);
  border-radius: var(--tx-radius-sm);
}
.tx-sidebar :focus-visible {
  outline-color: var(--tx-focus-light);
}
```

- Nunca `outline: none` sin sustituto. Grep obligatorio en revisión.
- El anillo tiene 2 px de tinta y 2 px de separación, más un halo de cobre al
  35 % (`--tx-focus-halo`) que es acabado, no indicador. El contraste que
  cumple 2.4.11 y el mínimo de 3:1 lo da el contorno de tinta (#171615 sobre
  marfil #F5F1E8, ~15:1). Las dos únicas reglas que declaran `box-shadow`
  propia y pueden recibir el foco (`.tx-skip-link:focus-visible`,
  `a.tx-stat:focus-visible`) vuelven a poner el halo al final de su lista.
- Ningún elemento con `position: sticky` puede tapar el foco: la cabecera del
  área de trabajo tiene `z-index: 20` y el contenido usa
  `scroll-margin-top: calc(var(--tx-space-16) + var(--tx-space-4))`.

> Corregido en step 16 (aviso D1). Decía 3 px y no mencionaba el halo: ambas
> cosas cambiaron en E5 de step 15. Tampoco hay tema oscuro que justifique
> una cifra de contraste «en oscuro»: el comentario de cabecera de
> `ui.css.ts` declara explícitamente que no existe (`@media
> (prefers-color-scheme: dark)` ausente a propósito).

### 9.2 Modelo de teclado

| Tecla | Efecto |
| --- | --- |
| `Tab` / `Shift+Tab` | Orden del DOM: salto → barra lateral → cabecera → contenido |
| `Enter` | Activa enlaces y botones (nativo) |
| `Espacio` | Activa botones, marca casillas y radios (nativo) |
| `Flechas` | Dentro de un grupo de radios (nativo). **No** se implementa navegación por flechas en la barra lateral: son enlaces, y el comportamiento nativo de lista de enlaces es el esperado |
| `Escape` | Cierra el diálogo abierto (nativo de `<dialog>`); cierra el panel de detalle de llamada y devuelve el foco a la fila de origen |
| `Home` / `End` | Nativo dentro de campos de texto |

- Toda la funcionalidad se alcanza sin ratón, incluida la resolución de cada
  cita impactada.
- Los envoltorios `.tx-table-scroll` llevan `tabindex="0"` para que la región
  desplazable sea alcanzable (2.1.1).
- **Regla de oro del sondeo:** el refresco de 2 s **no puede destruir un nodo que
  contenga `document.activeElement`**. Implementación obligatoria: reconciliación
  por clave (`data-key` con el id estable de la fila) y actualización sólo del
  `textContent` que haya cambiado. Vaciar y reconstruir el `<tbody>` cada 2 s —
  como hace hoy `ui.js.ts` — le roba el foco a Bruno cada dos segundos y hace la
  consola inusable con teclado. Además, mientras haya un `<dialog>` abierto, el
  sondeo sigue pero **no** repinta el contenido del diálogo.

### 9.3 Jerarquía de encabezados

```
h1  El título de la vista activa (exactamente uno por vista)
 h2 Título de panel ("Necesita tu atención", "Cifras del día"…)
  h3 Subtítulo dentro de un panel (nombre de profesional, título de tarjeta)
   h4 Sólo dentro del detalle técnico
```

Nunca se salta un nivel. La `h1` se actualiza con `textContent` al cambiar de
ruta y recibe el foco (`tabindex="-1"` + `.focus()`), que es el patrón correcto
de anuncio de cambio de vista en una aplicación de una sola página.

### 9.4 Roles y etiquetas ARIA necesarios

| Elemento | Marcado |
| --- | --- |
| Cabecera de la página | `<header>` (banner implícito) |
| Barra lateral | `<nav aria-label="Secciones de la consola">` |
| Enlace activo | `aria-current="page"` |
| Contenido | `<main id="contenido">` |
| Panel | `<section aria-labelledby="…">` con la `h2` referenciada |
| Tabla | `<table>` + `<caption class="tx-visually-hidden">` + `scope="col"` |
| Región desplazable | `role="region"` + `aria-label` + `tabindex="0"` |
| Estado de acción | `<p class="tx-status-line" role="status" aria-live="polite">` |
| Error de formulario | `role="alert"` + `aria-describedby` desde el campo + `aria-invalid="true"` |
| Diálogo | `<dialog aria-labelledby="…" aria-describedby="…">` + `showModal()` |
| Botón deshabilitado | `aria-disabled="true"` + `aria-describedby` al texto que explica por qué |
| Contadores de filtro | El número va dentro del texto visible (`Todas (7)`), no sólo en un `aria-label` |
| Glifos de estado | `aria-hidden="true"` — la etiqueta de texto ya lo dice |
| Detalle plegable | `<details>`/`<summary>` nativos (estado expuesto por el navegador) |
| Logotipo | `<img alt="Demo Salon Barbershop">` |
| Glifo TX | `aria-hidden="true"` cuando va junto al nombre; con `aria-label="Demo Salon"` cuando va solo |

**Lo que NO se hace:** no se pone `aria-live` en los KPI ni en las tablas. Con un
sondeo de 2 s, un lector de pantalla estaría hablando sin parar. Sólo hay
regiones vivas para **resultados de acciones que inicia Bruno** y para la pérdida
de conexión.

### 9.5 Regiones vivas: sólo para resultados de acciones del operador

**La regla, que es lo que manda:** hay una región viva (`role="status"` +
`aria-live="polite"`) por cada superficie donde una acción que **inicia el
operador** produce un resultado que hay que anunciar, más la de la cabecera
para la pérdida y recuperación de conexión. **Ninguna** en KPI, tablas, listas
ni contadores: con un sondeo de 2 s, un lector de pantalla estaría hablando sin
parar (§9.4). Ninguna `assertive`.

> ***Enmendado 2026-08-05 tras revisión adversarial de la capacidad 3,
> hallazgo M6/m11.*** *«Ninguna `assertive`» es la regla, pero seis regiones
> de la consola (`#huecos-error` y los cinco `role="alert"` de los diálogos
> de día especial, ausencia, cancelación de cita, alta en lista y grupo —
> `dia-especial-paso1-error`, `ausencia-paso1-error`, `cancelar-cita-error`,
> `alta-lista-error`, `grupo-error`) usan `role="alert"`, que el propio
> navegador trata como assertive implícito. Es una desviación PRE-EXISTENTE
> (ya estaba antes de esta misión, en las cinco primeras; `#huecos-error` la
> hereda del mismo patrón, step 19 capacidad 1) y no corregida hasta hoy: se
> declara aquí porque son errores de formulario de verdad — el mismo criterio
> que fija §9.4 («Error de formulario → `role="alert"`») — y bajarlos a
> `role="status"` cambiaría cuándo se anuncia un error de validación, que es
> una decisión de otra misión, no una reparación de plumbing.*

Las que existían al escribirse esta especificación:

1. `.tx-status-line` global de la cabecera → pérdida y recuperación de conexión.
2. Una por diálogo → resultado de la vista previa y de la publicación.
3. Una en Laboratorio → resultado del escenario y del reinicio.
4. Una en el panel de detalle → confirmación de "Copiado".

> Corregido en step 17. Este apartado se titulaba «exactamente cuatro» y
> enumeraba las cuatro de arriba como si fueran un cierre. El recuento era
> falso ya al añadir la pantalla «Lista de espera»: esa misión añade **una
> región viva por bloque interactivo** de esa pantalla (huecos liberados,
> cancelaciones fuera de plazo, personas apuntadas, plazo de cancelación —
> nodos `le-huecos-estado`, `le-tardias-estado`, `le-personas-estado`,
> `le-plazo-estado` en `ui.html.ts`) más la de cada uno de sus cuatro diálogos
> nuevos. La **regla** no ha cambiado ni una coma; lo que era mentira era el
> número. Ver §13 y (internal doc, not included in the template) §4.2 (desviación D6).

### 9.6 Tamaños de destino

- Acciones principales y entradas de navegación: **44 × 44 px** mínimo.
- Acciones dentro de una fila densa: **36 px** de alto con al menos **8 px** de
  separación entre ellas (supera el mínimo de 24 × 24 px de 2.5.8).
- Radios y casillas: 20 × 20 px visibles, con la etiqueta clicable y un área
  efectiva de 44 px de alto.

### 9.7 Cada estado, sin color

Ya está en §7.2. Resumen de los portadores: **texto siempre presente** (las seis
palabras del vocabulario nunca se abrevian ni se sustituyen por un punto de
color), **glifo distinto** (`✓ ! → ○ ✕ —`) y **borde distinto** (continuo,
discontinuo, punteado, 2 px, barra izquierda, sin relleno). Con la pantalla en
escala de grises, los seis estados siguen siendo distinguibles entre sí.

### 9.8 Otros

- `<html lang="es">` (ya está).
- Zoom al 200 % sin pérdida de contenido ni desplazamiento en dos ejes
  (1.4.10): todo el diseño usa `rem` y `max-width`, sin altura fija en
  contenedores de texto.
- Espaciado de texto (1.4.12): ninguna caja de texto tiene alto fijo; todas
  crecen.
- `prefers-reduced-motion: reduce` → sin transiciones.
- **No hay cambio de tema claro/oscuro.** Hay que **eliminar** el bloque
  `@media (prefers-color-scheme: dark)` y la declaración `color-scheme: light dark`
  que existen hoy en `ui.css.ts`: la paleta oscura actual no está verificada en
  contraste y duplicar temas duplica la superficie de error.

---

## 10. Mecánica de navegación: decisión

### Decisión: **una sola página con enrutado por hash (`#/seccion`)**

No se añaden rutas de servidor por sección.

### Justificación

1. **La CSP no es el problema, el estado sí.** `script-src 'self'` permite el
   `/app.js` externo que ya existe; un router por hash de unas 40 líneas cabe ahí
   sin ninguna concesión. Rutas de servidor tampoco violarían la CSP — pero
   obligarían a recargar la página entera en cada clic.
2. **Una recarga tira el estado en curso.** `ui.js.ts` mantiene en memoria
   `pendingChange` y `pendingImpacted`: la vista previa de un cambio de
   calendario que Bruno todavía no ha publicado. Con rutas de servidor, pulsar
   "Agenda" para comprobar una cita antes de decidir **borraría la vista previa
   sin avisar**. Con hash, no se pierde nada.
3. **Una recarga reinicia el sondeo.** Cada navegación volvería a arrancar el
   ciclo de 2 s desde cero y produciría un parpadeo de "Cargando…" en cada clic.
   Con una sola página hay **un** temporizador para toda la sesión.
4. **Coste de mantenimiento.** Seis rutas de servidor significan seis módulos de
   plantilla, seis veces el mismo shell (barra lateral, insignia, cabecera) y
   seis superficies donde la insignia obligatoria puede olvidarse. Con una sola
   página, la insignia está escrita **una vez** en `ui.html.ts` y es
   estructuralmente imposible que falte en una sección.
5. **Superficie de pruebas.** Cada ruta nueva necesitaría su propia comprobación
   de cabeceras de seguridad en `tests/console/console.test.ts`. Cero rutas
   nuevas, cero cobertura nueva que se pueda olvidar.

### Especificación del router

**Rutas.**

```
#/inicio        (por defecto; también con hash vacío o desconocido → #/inicio)
#/agenda
#/agenda/2026-08-05          (día concreto, opcional)
#/llamadas
#/llamadas/<callIdHash>      (abre el panel de detalle)
#/calendario
#/calendario/2026-08         (mes concreto)
#/equipo
#/laboratorio
```

**Implementación.**

- Las seis vistas están **todas** en el HTML estático de `ui.html.ts`, como
  `<section id="vista-inicio" hidden>`, etc. El router sólo cambia la propiedad
  `hidden` (booleana, no es un estilo en línea, no es `innerHTML`). Esto respeta
  `style-src 'self'` sin ninguna gimnasia.
- Los enlaces de la barra lateral son `<a href="#/agenda">` **reales**: se pueden
  enfocar, abrir en pestaña nueva, copiar y recorrer con `Tab` sin una línea de
  JS. No se usa `<div onclick>` en ningún sitio.
- El router escucha `hashchange` y hace una pasada inicial en `DOMContentLoaded`.
  No se usa la History API: con `<a href="#…">` el navegador ya empuja la entrada
  al historial.

**Historial del navegador.**
- Atrás y adelante funcionan entre secciones, porque cada clic en un enlace crea
  una entrada.
- Abrir el detalle de una llamada (`#/llamadas/<hash>`) **crea** entrada: cerrar
  el detalle con `Escape` o con "Cerrar" llama a `history.back()`, de modo que el
  botón Atrás del navegador y el botón Cerrar de la interfaz hacen lo mismo.
- Los pasos del diálogo de calendario **no** crean entradas de historial: son un
  formulario, y un Atrás del navegador que deshiciera medio formulario sería
  peor que inútil. El diálogo se cierra con `Escape`/`Cancelar`.

**Teclado y foco al cambiar de ruta.**
1. Se actualiza `document.title`.
2. Se actualiza el `textContent` de la `h1` y se le da el foco
   (`tabindex="-1"` + `.focus({ preventScroll: false })`).
3. Se pone `aria-current="page"` en el enlace nuevo y se quita del anterior.
4. El área de trabajo vuelve arriba (`scrollTo(0, 0)`), salvo cuando la ruta
   sólo abre un detalle dentro de la misma sección.

**Rutas desconocidas.** Se muestra la vista de Inicio con la línea de estado
`Esa página no existe.` — nunca una pantalla en blanco.

---

## 11. Lo que se ha excluido a propósito

Cada entrada lleva el motivo, para que nadie la "arregle" más adelante.

| Excluido | Por qué |
| --- | --- |
| **Cualquier gráfico** (líneas, barras, tarta, sparkline, donut) | Ninguno responde "¿qué necesita mi atención?". Con 7 llamadas sintéticas, un gráfico es decoración que finge análisis. Prohibido explícitamente por la misión. |
| **Ingresos, ventas, ticket medio, precios** | El motor no conoce precios y `domain/types.ts` prohíbe añadirlos. Enseñar dinero convertiría la consola en otro producto. |
| **Crecimiento de clientes, clientes recurrentes, popularidad de servicios** | No hay identidad de cliente en los datos, por diseño de privacidad. Cualquier cifra así sería inventada. |
| **Tema claro/oscuro** | Un solo espacio de trabajo claro con barra oscura. Dos temas son el doble de pares de contraste que verificar, y el actual bloque oscuro de `ui.css.ts` no está verificado. Hay que borrarlo. |
| **Avatares y fotos del equipo** | Las personas son sintéticas. Ponerles cara sugeriría que son reales. |
| **Nombres, teléfonos o notas de cliente** | No existen en los datos y no deben existir. |
| **Motivo de la ausencia** | `privateReason` no sale del servidor. La interfaz ni siquiera tiene un sitio donde ponerlo. |
| **Cualquier número de latencia** | No se mide (`PILOT_METRICS.md`). El único lugar donde se nombra es Laboratorio, y sólo para decir que no se mide. Nunca un `0`, nunca un guion que parezca una medida. |
| **Notificaciones de escritorio, sonidos, insignias parpadeantes** | Esta consola existe para **no** interrumpir a nadie. Interrumpir con la propia consola sería contradecir su razón de ser. |
| **Barra de progreso o "puntito en vivo" animado** | Sólo se puede afirmar "en vivo" lo que el sondeo actualiza de verdad: la marca de hora. Un pulso animado es una promesa que no verifica nada. |
| **Arrastrar y soltar en el calendario** | Mover una cita arrastrándola es exactamente el gesto que puede cambiar una reserva sin vista previa. El flujo de tres pasos es obligatorio. |
| **Acción masiva sobre citas afectadas** ("aplicar a todas") | Contradice la regla de resolver una por una. `applyChange` la exige y la interfaz no debe insinuar un atajo. |
| **Buscador global** | Con este volumen no aporta, y un buscador invita a buscar clientes, que es justo lo que no hay. |
| **Exportar CSV / imprimir** | Nada que exportar: son datos sintéticos y ya hay JSON crudo en Laboratorio. |
| **Inicio de sesión, usuarios, permisos** | No hay superficie pública que proteger: `127.0.0.1`, sin cookies, sin credenciales. Un login falso daría una sensación de seguridad falsa. |
| **Transcripciones o audio de la llamada** | No existen en el modelo, y su ausencia es una garantía de privacidad, no una carencia que rellenar. |
| **Fuentes web, iconos de CDN, tipografía de marca** | La CSP no permite orígenes externos y el sistema no tiene red. Pila de fuentes del sistema y glifos de texto. |
| **Cualquier framework, bundler o dependencia npm de UI** | Decisión de arquitectura ya tomada: tres módulos de plantilla y nada más. |
| **Selector de idioma** | La consola es para Bruno, en castellano. |
| **Modo pantalla completa / quiosco** | No se ha pedido y añade estado que gestionar. |

---

## 12. Orden de implementación recomendado

Nueve pasos. Cada uno deja la consola funcionando; ninguno depende de que el
siguiente esté hecho.

**Paso 0 — Contrato de datos y activos (bloqueante).**
Sin esto, la mitad de la interfaz no se puede construir con datos verdaderos.
- Ampliar `snapshot.ts` con lo del **Anexo A.1**, siempre con lista explícita,
  nunca con `spread`.
- Añadir `img-src 'self'` a la CSP (**Anexo A.2**).
- Añadir las rutas estáticas `GET /brand/demo-salon-logo.png` y `GET /favicon.svg`
  (**Anexo A.3**).
- Test: la CSP publicada contiene exactamente `img-src 'self'` y **no** contiene
  `data:`, `blob:` ni ningún origen remoto.

**Paso 1 — Tokens y estructura.**
Reescribir `ui.css.ts` con los tokens de §3; **borrar** el bloque
`prefers-color-scheme: dark` y `color-scheme: light dark`. Reescribir
`ui.html.ts` con el shell de §4: barra lateral, marca sobre placa clara,
cabecera, insignia estática, `<main>`, enlace de salto y las seis
`<section hidden>` vacías. Router por hash en `ui.js.ts` (§10). Al final de este
paso se navega entre seis secciones vacías, con teclado e historial.

**Paso 2 — Vocabulario de estado.**
Un solo mapa constante en `ui.js.ts` que implementa §7.1 y §7.2, más el
componente `.tx-pill`. Se hace antes que cualquier vista porque las cinco lo
usan. Test: los once `internalReasonCode` producen las seis etiquetas esperadas.

**Paso 3 — Inicio.**
`.tx-stat`, `.tx-attention-card`, `.tx-empty`, la cola humana y la actividad
reciente. Con esto ya se contesta la pregunta principal de Bruno.

**Paso 4 — Llamadas + detalle.**
`.tx-call-row`, filtros, panel de detalle con ruta profunda y `<details>`
técnico. Aquí se cierra el camino "inspeccionar una llamada derivada" y
"¿el fallo tocó una reserva?".

**Paso 5 — Agenda.**
`.tx-appt-row`, agrupación por día, separador de pasadas, horario del día leído
de los datos.

**Paso 6 — Equipo.**
Fichas por profesional, horario semanal desde los datos, `.tx-absence-chip` y el
diálogo de tres pasos de "Añadir ausencia" reutilizando `.tx-impact-table`.

**Paso 7 — Calendario.**
Rejilla mensual, `.tx-day-cell`, lista de días distintos, "Añadir día especial"
(mismo diálogo) y el aviso de horario de temporada. Si el Anexo B.1 aún no está
resuelto, el aviso se implementa **leyendo los datos que haya** y mostrando
`Pendiente de confirmar` — nunca escribiendo el horario de agosto a fuego en la
interfaz.

**Paso 8 — Laboratorio.**
Mover ahí, sin perder nada, todo lo que hoy vive en la página única: ejecutor de
escenarios, recuento de eventos, auditoría, JSON crudo y reinicio con su diálogo
de confirmación.

**Paso 9 — Adaptación, accesibilidad y pruebas.**
- Los cuatro puntos de ruptura de §4.5, incluida la conversión de tablas a fichas.
- Reconciliación por clave del sondeo (§9.2) — **no dejarlo para el final es más
  seguro, pero como muy tarde va aquí**.
- Repaso de foco, encabezados, ARIA y tamaños de destino.
- Tests nuevos sugeridos, en la línea de los que ya hacen grep del fichero:
  - `ui.css.ts` no contiene `prefers-color-scheme`.
  - `ui.js.ts` no contiene `innerHTML` (ya existe) **ni** `.style.`.
  - `ui.html.ts` contiene la cadena exacta `Demo local · Datos sintéticos · No producción`.
  - Ninguna cadena de las vistas operativas contiene `latencia`, `€`, `precio`,
    `reasonCode` ni `scenarioId` (salvo dentro del bloque de Laboratorio y de los
    `<details>` técnicos).

---

## 13. La pantalla «Lista de espera» (añadida en step 17)

> Añadido en step 17. Esta especificación se escribió para las **seis**
> secciones de §2.1. step 17 añade una séptima ruta operativa, y este
> apartado existe para que §2.1 no se quede diciendo que son seis sin más.
> **Aquí no se especifica la pantalla**: sólo se registra que existe y dónde
> está su especificación de detalle.

**Especificación normativa de detalle:**
(internal doc, not included in the template). Decisiones,
desviaciones y límites: (internal doc, not included in the template).
Verificación visual obligatoria en navegador real:
(internal doc, not included in the template), Parte II.

| Sección | Ruta | La pregunta que contesta | Lo que NUNCA aparece aquí |
| --- | --- | --- | --- |
| **Lista de espera** | `#/lista-espera` | ¿Qué huecos se han liberado, quién de la lista encaja, y qué decisión falta por tomar? | Prioridades, plazos de caducidad, cuentas atrás, datos de cliente, cifras de tiempo |

**Anclas estables** (nombre de nodo, de función o de constante; nunca número de
línea, por el aviso A1 de step 16):

- Entrada de navegación: el `<a data-route="lista-espera">` de `.tx-nav__list`
  en `ui.html.ts`, **entre Agenda y Llamadas**, con el glifo `◷`. La lista
  principal pasa así de cinco a seis entradas; Laboratorio sigue aparte, bajo
  `.tx-sidebar__tools-label`.
- Vista: `<section id="vista-lista-espera" class="tx-view">` en `ui.html.ts`.
- Pintado: `renderListaEspera()` en `ui.js.ts`, entre los comentarios
  `LISTA DE ESPERA (step 17 §9) — INICIO DEL BLOQUE` y
  `LISTA DE ESPERA — FIN DEL BLOQUE`.
- Datos: la clave `waitlist` del snapshot, proyectada **entera en servidor** por
  `buildWaitlistSnapshot()` en `src/console/waitlistSnapshot.ts`.
- Textos de las no-reglas: la constante `WAITLIST_COPY`, en ese mismo fichero,
  única fuente de verdad (las de bloque están además escritas literalmente en
  `ui.html.ts`, y una prueba las compara carácter a carácter).
- Diálogos nuevos: `dialogo-cancelar-cita`, `dialogo-alta-lista`,
  `dialogo-simular-aviso`, `dialogo-convertir`.

**Lo que esta pantalla hereda sin excepción de esta especificación:** los
tokens de §3, la rejilla y los puntos de ruptura de §4, el vocabulario de
estado de §7 (píldora con glifo + texto, nunca color solo), la regla de capas
de §2.2 (ningún enum técnico fuera del `<details>` «Detalle técnico»), el
contrato de foco de §9.1 y la regla de regiones vivas de §9.5.

**Lo que añade y no estaba en esta especificación:** una tarjeta de decisión
(`.tx-slot-card`) con un `radiogroup` **sin preselección**, una línea de estado
de **conflicto** distinta de la de error (`.tx-status-line--conflict`), la fila
de cita cancelada (`.tx-table__row--cancelled`) y la lista de cifras
(`.tx-figure-list`). Los cuatro están descritos en el documento de detalle.

---

## 14. Inasistencias, reloj de demostración y reserva para varias personas (añadido en step 18)

> Añadido en step 18. **Aquí no se especifica nada**: se registra que estas
> superficies existen, dónde vive cada una y dónde está su especificación de
> detalle. Nada de §1 a §13 se reescribe.

**Especificación normativa de detalle:**
(internal doc, not included in the template). Decisiones,
desviaciones, comportamientos conocidos y límites:
(internal doc, not included in the template). Verificación visual y con lector
de pantalla, obligatoria en navegador real:
(internal doc, not included in the template), Parte III.

**Ninguna ruta nueva.** `ROUTE_TITLES` no crece y la barra lateral sigue con las
mismas entradas: todo esto vive en **Agenda**, **Inicio** y **Laboratorio**.

**Anclas estables** (nombre de nodo, de función o de constante; nunca número de
línea, por el aviso A1 de step 16):

- **Agenda.** El botón `#btn-abrir-grupo` («Nueva reserva para varias
  personas»), dentro del bloque de controles de `<section id="vista-agenda">`; y
  la celda de acción de cada fila, que pinta `pintarCeldaAccionAgenda()` en
  `ui.js.ts` — es **esa función**, y no `renderAgenda`, la que el criterio 8.20
  del diseño acota: `renderAgenda` sí llama a `resolveVenueDay`, pero sólo para
  el rótulo «Horario del local», heredado de step 14.
- **Inicio.** El párrafo `#inicio-inasistencias`, dentro del panel de contexto
  que ya existía. Su texto llega compuesto del servidor (`metrics.homeLine`) y es
  `null` cuando no hay ninguna: la interfaz no decide cuándo ocultarlo.
- **Laboratorio.** Tres paneles, en este orden: `#tit-lab-reloj` («Reloj de la
  demostración»), `#tit-lab-grupo` («Reservas para varias personas (ejemplos)»)
  y el historial `#lab-operaciones-lista`, **aparte** del de calendario y del de
  la lista de espera; no se fusionan porque con un reloj sintético dos eventos de
  registros distintos pueden compartir instante.
- **Cabecera.** `#tx-reloj-sintetico` («Reloj de la demostración: …»), que **no**
  es región viva porque se repinta cada 2 s; y `#tx-freshness`, que desde esta
  misión dice «(hora de tu ordenador)» — eran dos relojes sin rótulo.
- **Diálogos nuevos:** `dialogo-inasistencia`, `dialogo-corregir-inasistencia` y
  `dialogo-grupo` (cuatro pasos). Están colocados en `ui.html.ts` **después** de
  `id="vista-llamadas"`, y esa colocación es **normativa**: entre las anclas
  `vista-lista-espera` y `vista-llamadas` caerían dentro del corte de HTML que
  examina el criterio 22 de step 17.
- **Datos:** la clave `operations` del snapshot, proyectada **entera en
  servidor** por `buildOperationsSnapshot()` en
  `src/console/operationsSnapshot.ts`. Es la **segunda y última** clave de primer
  nivel que este proyecto autoriza (la lista blanca de
  `tests/console/console.test.ts` sigue fallando ante cualquier otra).
- **Textos de las no-reglas:** las constantes `OPERATIONS_COPY` y `GROUP_COPY`,
  en ese mismo fichero, únicas fuentes de verdad. La interfaz **no compone
  ninguna**.
- **Ciclo de vida de las líneas de estado:** `setEstadoLinea()`, `limpiarLinea()`,
  `TONO_BASE` y `REGIONES_TRANSITORIAS` en `ui.js.ts`; la región persistente
  `#estado-global`, en `<main>` y **fuera de todo `<dialog>`**, es donde se
  anuncia el reinicio.

**Lo que hereda sin excepción de esta especificación:** los tokens de §3, la
rejilla y los puntos de ruptura de §4, el vocabulario de estado de §7 (píldora
con glifo + texto, nunca color solo), la regla de capas de §2.2 (ningún enum
técnico fuera del `<details>` «Detalle técnico»), el contrato de foco de §9.1 y
**la regla** de regiones vivas de §9.5.

**Lo que añade.** Seis regiones vivas más —las de los tres diálogos nuevos, la
del panel del reloj, la del panel de ejemplos de grupo y la global
`#estado-global`—, todas ellas resultado de una acción que inicia el operador,
que es exactamente lo que §9.5 permite. La regla de §9.5 no cambia; su recuento,
como ya avisaba su nota de step 17, tampoco es un cierre. Y una regla de CSS
nueva, `.tx-status-line[hidden] { display: block !important; visibility:
hidden; }` con tres excepciones declaradas por id, que es lo que saca del árbol
de accesibilidad una línea vacía **sin** cambiar la maquetación (`min-height` de
`.tx-status-line` intacto).

---

## 15. Reparaciones de navegador y preparación del operador (añadido en step 19)

> Añadido en step 19. **Aquí no se especifica nada**: se registra que estas
> superficies existen, dónde vive cada una y dónde está su especificación de
> detalle. Nada de §1 a §14 se reescribe.

**Especificación normativa de detalle:**
(internal doc, not included in the template).
Decisiones, desviaciones, comportamientos conocidos y las dos preguntas
abiertas nuevas (L1–L2): (internal doc, not included in the template).
Verificación visual y con lector de pantalla, obligatoria en navegador real:
(internal doc, not included in the template), Parte IV (51 puntos).
Plantilla de decisiones del propietario: `docs/operator_console/DECISION_PACK_TEMPLATE.md`.

**Ninguna ruta nueva de navegación.** `ROUTE_TITLES` no crece y la barra
lateral sigue con las mismas siete entradas: todo esto vive en **Agenda** y
**Laboratorio**. Sí crece la superficie de **API**: `GET
/api/availability/explore` es la primera ruta nueva de esta consola desde
step 18, y es de **lectura pura** — sin `Idempotency-Key`, sin cuerpo, sin
efecto en `availabilityQueries`, repetible sin consecuencia.

**Anclas estables** (nombre de nodo, de función o de constante; nunca número
de línea, por el aviso A1 de step 16):

- **Agenda.** El panel `#huecos-panel` («Comprobar huecos sintéticos»),
  colocado inmediatamente después de `.tx-controls` y antes de
  `#agenda-dias` — panel **en línea**, no un `<dialog>` nuevo, por las
  cuatro razones del diseño §3.2 (comparación visual, coste del sondeo,
  «un diálogo confirma una acción y aquí no hay ninguna que confirmar»,
  discoverabilidad).
- **Laboratorio.** Dos paneles nuevos arriba del todo —**«Guion en pantalla
  para enseñar la demostración»** (3B) antes de **«Resumen para revisar con
  Bruno»** (3A), en ese orden, porque uno se abre antes de empezar y el otro
  se enseña al final— y un cuarto historial, **«Historial de tareas
  humanas»**, entre «Historial de operaciones de consola» y el panel «Cómo
  funcionan por dentro…».
- **Inicio.** Ningún nodo nuevo. `ui.js.ts` deja de usar
  `snap.humanQueue.tasks` entera para el contador y la lista de «Cosas que
  hacer una persona»: filtra por `t.open`, la misma definición que ya
  publica `metrics.pendingHumanTasks`.
- **Datos:** la clave `demo` del snapshot, proyectada **entera en servidor**
  por `src/console/demoWorkspace.ts` (medidas del resumen, pasos de los dos
  guiones, texto copiable ya resuelto). Es la **tercera y última** clave de
  primer nivel que este proyecto autoriza (step 17 añadió `waitlist`,
  step 18 añadió `operations`); la lista blanca de
  `tests/console/console.test.ts` sigue fallando ante cualquier otra. Y un
  campo nuevo en `ConsoleTaskView`, `completedAtISO?: string`, presente
  **sólo** cuando el almacén lo tiene.
- **Textos:** `AVAILABILITY_EXPLORER_COPY` (`availabilityExplorer.ts`),
  `HUMAN_TASK_LEDGER_COPY` (`snapshot.ts`) y `SUMMARY_COPY`/`GUIDE_COPY`
  (`demoWorkspace.ts`), únicas fuentes de verdad de sus superficies. La
  interfaz **no compone ninguna** frase de negocio nueva, salvo las dos
  excepciones declaradas a I2 —formato de fecha del libro de tareas y el
  sello de copia del resumen— que el diseño §7.1 fija y acota.

**Lo que hereda sin excepción de esta especificación:** los tokens de §3, la
rejilla y los puntos de ruptura de §4 (ampliados con el punto de ruptura de
690 px para el panel de recuentos y el diálogo de grupo, §2.1/§2.2 del
diseño), el vocabulario de estado de §7, la regla de capas de §2.2, el
contrato de foco de §9.1 y **la regla** de regiones vivas de §9.5.

**Lo que quita.** Esta misión es la primera que **reduce** el recuento de
regiones vivas transitorias en vez de aumentarlo: `#tx-freshness` deja de
ser `role="status"` (repintaba con segundos cada 2 s, un anuncio perpetuo
que contradecía §9.5 desde antes de esta misión) y su transición de
conexión pasa a una región nueva, dedicada y silenciosa en reposo,
`#tx-conexion-anuncio`; las tres líneas del bloque del guion en pantalla
—aviso estático, luz de precondición y contador de progreso— nacen **sin**
`role`/`aria-live`, porque ninguna de las tres es el resultado de una acción
que inicie el operador. El detalle completo, con el recuento exacto y su
descomposición, vive en el informe de UI/UX de la fase 12 de esta misión y
en (internal doc, not included in the template), Parte IV, puntos F3–F5.

---

## 16. Taller de decisiones con Bruno (añadido en step 20)

> Añadido en step 20. **Aquí no se especifica nada**: se registra que esta
> superficie existe, dónde vive y dónde está su especificación de detalle.
> Nada de §1 a §15 se reescribe.

**Especificación normativa de detalle:**
(internal doc, not included in the template)
(D20-1…D20-56, I20-1…I20-17, E20-1). Decisiones, desviaciones,
comportamientos conocidos y las cuatro preguntas abiertas nuevas de
herramienta (M1–M4): (internal doc, not included in the template).
Verificación visual y con lector de pantalla, obligatoria en navegador
real y **toda pendiente**: (internal doc, not included in the template), Parte V
(§25–§29, catorce puntos). Runbook corto de la reunión:
(internal doc, not included in the template). Plantilla de decisiones: `DECISION_PACK_TEMPLATE.md`.

**Ninguna ruta nueva, ni de navegación ni de API.** `ROUTE_TITLES` no
crece; la barra lateral sigue con las mismas siete entradas; las dos rutas
`GET` existentes siguen siendo las únicas, y no hay ninguna ruta de
escritura nueva. El taller viaja entero dentro de `GET /api/snapshot`,
como *slice* de la clave `demo` (`demo.decisionWorkshop`): **no** es una
clave de primer nivel nueva, y la lista blanca cerrada de
`tests/console/console.test.ts` sigue vigente.

**Anclas estables** (nombre de nodo, de función o de constante; nunca
número de línea):

- **Laboratorio.** El panel `#tit-lab-taller` («Taller de decisiones con
  Bruno»), **tercer** panel del Laboratorio, entre «Resumen para revisar
  con Bruno» (`tit-lab-resumen`) y el panel del reloj (`tit-lab-reloj`):
  10 bloques, 32 tarjetas, cinco filtros, búsqueda local con rebote, una
  nota corta opcional por tarjeta y dos botones de exportación por
  portapapeles.
- **Datos:** `src/console/decisionCatalog.ts` (el catálogo tipado,
  congelado en profundidad, validado V1–V8 al cargar) y la vista
  `decisionWorkshop`, compuesta **una vez** al cargar el módulo en
  `src/console/demoWorkspace.ts` con huella FNV-1a de todo el contenido
  servido: el panel no se repinta con el sondeo.
- **Textos:** `WORKSHOP_COPY`, `ACTA_COPY` y `MISION_COPY`
  (`demoWorkspace.ts`), únicas fuentes de verdad de sus superficies. La
  composición del acta y del borrador de misión en el navegador es la
  **excepción declarada y acotada E20-1** al invariante I2: el borrador
  sólo existe en el navegador, y el cliente sólo concatena constantes
  servidas, texto verbatim del catálogo y notas saneadas — seis
  operaciones cerradas, ninguna más.
- **Borrador:** memoria de la pestaña, y nada más. Recargar la página lo
  borra; **el reinicio de la demostración no lo toca** (D20-27) — la
  lista cerrada de lo que borra el reinicio sigue siendo cierta sin
  cambiar una palabra.

**Lo que hereda sin excepción de esta especificación:** los tokens de §3,
la rejilla y los puntos de ruptura de §4, el vocabulario de estado de §7,
la regla de capas de §2.2, el contrato de foco de §9.1 y **la regla** de
regiones vivas de §9.5.

**Lo que añade.** Tres regiones vivas (`#tx-taller-estado`,
`#tx-taller-acta-estado`, `#tx-taller-mision-estado`), las tres resultado
de una acción que inicia el operador, que es exactamente lo que §9.5
permite; la línea de cobertura del panel **no** es región viva a
propósito (se repinta con cada marca de radio, y una locución ahí sería
una segunda encima de la del propio radio). Las dos líneas de estado de
copiado entran en las transitorias que el reinicio limpia; la de filtros
y la de cobertura quedan fuera porque siguen siendo ciertas tras el
reinicio. El detalle, con sus enmiendas fechadas de recuento, vive en
`tests/console/resetAccesible.test.ts` y en (internal doc, not included in the template) §6.

---

## Anexo A — Cambios de servidor que esta especificación necesita

Son tres, pequeños y acotados. No los implementa este documento.

### A.1 Ampliación del `ConsoleSnapshot`

Hoy `snapshot.ts` **no expone** cosas que la interfaz necesita para no mentir.
Todo lo siguiente se construye campo a campo, con lista explícita, respetando la
regla del docblock (nunca `spread`).

| Campo nuevo | Origen | Por qué es imprescindible |
| --- | --- | --- |
| `engineToday: string` | `clock.nowISODate()` | **Crítico.** El motor corre con reloj fijo (`fixedClock(BOOKING_DEMO_TODAY, BOOKING_DEMO_NOW_MINUTES)` en `server.ts`, con `BOOKING_DEMO_TODAY = "2026-08-04"`), mientras `generatedAt` es la hora real. Si "hoy" se calcula en el navegador con la fecha real, Agenda e Inicio saldrán vacíos siempre. "Hoy" tiene que ser el día del motor. |
| `engineNowMinutes: number` | `clock.nowMinutes()` | Separar citas pasadas de futuras, y marcar "SIGUIENTE". |
| `calls[].outcome` | evento interno `INTERNAL_OUTCOME_RESOLVED`, `detail.outcome` | Sin esto no hay píldora de estado posible. |
| `calls[].reasonCode` | ídem, `detail.pilotV1ReasonCode` | Detalle técnico. |
| `calls[].internalReasonCode` | ídem, `detail.internalReasonCode` | La regla de §7.1 lo exige. |
| `calls[].countsAsNotUnderstood` | ídem | Métricas honestas. |
| `calls[].countsAsBookingConversion` | ídem | KPI "Reservas creadas hoy". |
| `calls[].countsAsContained` | ídem | KPI "Resueltas sin molestar a nadie". |
| `calls[].announcesSuccess` | ídem | "¿Se dijo al cliente que estaba confirmada?" |
| `calls[].requiresOperatorReview?: boolean` | resultado de la conversación | La tarjeta de reserva huérfana. |
| `humanQueue.tasks[].reasonKind` | clasificación en servidor de `HumanTask.reason` | Ver A.1.1. |
| `calendar.weeklySchedules` | `cal.weeklySchedules` | Equipo y Agenda muestran horarios **de los datos**, no de un texto escrito a mano. |
| `calendar.capabilities` | `cal.capabilities` (serializado como `{employeeId, serviceIds[]}`) | "Puede hacer" (literal `'Puede hacer'` en `ui.js.ts`; corregido en step 16, reparación adversarial 2ª ronda, F1 — este anexo citaba la etiqueta más larga que llevaba la ficha antes de la FASE 3B). |
| `calendar.slotMinutes` | `cal.slotMinutes` | Duración mostrada. |
| `calendar.seasonalSchedules` | **no existe** | Ver Anexo B.1. |

Todo esto ya está disponible: `INTERNAL_OUTCOME_RESOLVED` se emite exactamente
una vez por llamada (`engine.ts:755-769`) con esos siete campos en `detail`. La
ampliación es de lectura, no cambia el motor y **no toca el flujo congelado del
piloto**.

**A.1.1 — El problema de `HumanTask.reason`.** En `engine.ts:615`, una derivación
normal crea la tarea con `reason: script.scenarioId`. Es decir, lo que hoy vería
Bruno en su cola de acciones es literalmente `A22-console-urgencia`. Recomendación:
clasificar en el servidor a un `reasonKind` cerrado
(`CALLBACK_FROM_CALL` | `REVIEW_ORPHANED_SYNTHETIC_RESERVATION` |
`CONTACT_CLIENT_ABOUT_CALENDAR_CHANGE` | `UNKNOWN`) y dejar el valor crudo sólo
en el detalle técnico. La interfaz **no** debe deducirlo con una expresión
regular sobre `A\d\d-`: eso es lógica de negocio en el navegador.

### A.2 La CSP bloquea todas las imágenes

`default-src 'none'` sin `img-src` significa que el navegador **rechaza** el
`<img>` del logotipo y también el favicon. Cambio mínimo y suficiente en la
constante `CSP` de `server.ts`:

```
default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'
```

Nada más. Ni `data:`, ni `blob:`, ni ningún origen remoto: el logotipo se sirve
desde el propio proceso.

### A.3 No hay ruta para el activo de marca

`assets/brand/demo-salon-logo.png` está versionado pero no se sirve. Hacen falta dos
rutas explícitas, en la misma línea que `/app.css` y `/app.js` (nada de servir un
directorio entero, nada de `@fastify/static`, nada de resolución de rutas a
partir de la petición):

- `GET /brand/demo-salon-logo.png` → lee el fichero una vez al arrancar, lo cachea en
  memoria y responde con `Content-Type: image/png`.
- `GET /favicon.svg` → cadena SVG literal con el glifo "TX",
  `Content-Type: image/svg+xml`. Con `img-src 'self'` y `X-Content-Type-Options:
  nosniff`, un SVG servido con su tipo correcto y sin script es seguro; aun así,
  el SVG **no debe contener `<script>` ni `<foreignObject>`**.

---

## Anexo B — Huecos abiertos que hay que decidir antes de dar por buena la consola

### B.1 [G] El horario estacional de agosto no existe en el modelo

- **Lo que pide el cliente:** agosto (mes entero, con año) de martes a viernes
  09:00–17:30, sábado 09:00–14:00, lunes y domingo cerrado, para todos los
  trabajadores en activo, **como anulación estacional fechada** que se pueda
  duplicar y confirmar en años siguientes.
- **Lo que hay:** `resolveAvailability.ts` implementa **seis** niveles
  (cierre → regla de local → ausencia → anulación de empleado → horario semanal →
  reservas). No hay ningún nivel estacional, y `WeeklySchedule` no tiene fechas:
  es eterno por construcción.
- **Consecuencia si no se resuelve:** la consola sólo puede *contar* el horario
  de agosto como texto, no *mostrarlo* desde los datos, y el motor seguiría
  ofreciendo horas fuera de él. Sería exactamente la "suposición eterna sin
  revisar" que el requisito prohíbe.
- **Recomendación:** añadir `SeasonalVenueSchedule { id, startDate, endDate,
  dayOfWeek, workDayStart, workDayEnd, source, approval, audit }` como **nivel 5**
  (entre anulación de empleado y horario semanal), con la misma semántica de
  fallo cerrado: si `approval !== 'approved'`, se ignora por completo. Duplicar
  para el año siguiente crea un registro `pending_review` que **no se aplica**
  hasta que alguien lo confirme. La interfaz de §5.4 ya está diseñada para esa
  semántica.

### B.2 [G] El horario de la fixture contradice el horario de negocio

- **Fixture:** Álex y Dani, lunes y martes 09:00–17:00 con descanso 13:00–14:00;
  Nerea, lunes, martes y miércoles 10:00–16:00.
- **Negocio declarado:** lunes cerrado; martes a viernes 09:30–19:30; sábado
  09:00–14:00; domingo cerrado.
- **Consecuencia:** la consola **enseñará el lunes abierto**, contradiciendo el
  horario que Bruno acaba de dictar, y quien lo vea concluirá que la consola
  miente. No se arregla en la interfaz: la interfaz debe leer los datos.
- **Recomendación:** decidir explícitamente una de dos y dejarlo escrito.
  (a) Actualizar `extendedSyntheticVenue()` al horario de negocio — pero **no**
  `baseSyntheticVenue()`, que respalda los escenarios congelados A01..A15 y cuyo
  docblock dice que no debe cambiar. (b) Dejar la fixture y aceptar que la demo
  muestra un horario inventado, diciéndolo en pantalla. Recomiendo (a), con una
  fixture nueva para la consola si tocar la extendida rompe tests de asignación.

### B.3 [G] Las etiquetas de servicio están duplicadas y no coinciden con el enunciado

- `src/callEngine/domain/types.ts` define `SERVICE_LABELS = { 0: "Barba",
  1: "Corte de pelo", 2: "Corte y barba" }`.
- `src/console/ui.js.ts` **vuelve a declarar el mismo mapa** (`var
  SERVICE_LABELS = ...`) dentro de la cadena de JS del navegador. Dos copias
  que pueden divergir en silencio.
- El enunciado de la misión dice "Corte, Barba, Corte + barba".
- **Recomendación:** una sola fuente de verdad. `renderConsoleAppJs()` debe
  **interpolar** `SERVICE_LABELS` importado de `domain/types.ts` (con
  `JSON.stringify`) en lugar de reescribirlo. Si Bruno prefiere "Corte" a "Corte
  de pelo", se cambia **una vez**, ahí. La interfaz nunca inventa una etiqueta de
  servicio.

### B.4 [G] El sondeo destruye el foco

`refresh()` vacía y reconstruye cada `<tbody>` cada 2 s. Con teclado, el foco se
pierde dos veces por segundo… cada dos segundos, y con un lector de pantalla el
contexto salta. No es una mejora estética: hoy la consola es inusable sin ratón.
Solución en §9.2 (reconciliación por clave, y nunca sustituir un nodo que
contenga `document.activeElement`).

### B.5 [P] `privateReason` sigue siendo aceptable en la API de publicación

`CHANGE_SCHEMA` en `server.ts` (rama `changeKind: "employee_absence"`) acepta
`privateReason` en el cuerpo y lo propaga al modelo, aunque `snapshot.ts`
nunca lo devuelva. La interfaz especificada **no lo envía nunca**.
Recomendación: dejarlo así (el modelo lo contempla y la frontera de lectura
ya está probada), pero añadir un test que
verifique que `ui.html.ts` y `ui.js.ts` no contienen la cadena `privateReason`,
para que ningún cambio futuro lo cuele por la interfaz.
