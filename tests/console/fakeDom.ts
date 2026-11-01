/**
 * step 14 repair (defecto C) — un DOM falso MÍNIMO, escrito a mano, para
 * ejecutar `renderEquipo()` (la función REAL servida por `/app.js`, vía
 * `loadUiClientHooks` en `uiClientExtract.ts`) contra un `document` que de
 * verdad soporta `createElement`/`getElementById`/`appendChild`/
 * `insertBefore`/`removeChild`/`querySelector`/`classList`.
 *
 * Esta misión prohíbe instalar una dependencia nueva (jsdom/happy-dom/etc.)
 * sin una justificación fuerte, y no la hay para una sola función: de ahí
 * esta implementación deliberadamente pequeña, que sólo cubre lo que
 * `renderEquipo` (y su ayudante `reconcileList`) realmente usan. No pretende
 * ser un DOM completo ni sirve para nada más que esta prueba.
 */

export class FakeElement {
  readonly tagName: string;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  hidden = false;
  onclick: (() => void) | null = null;
  /**
   * (step 18, fase G) `onchange` de verdad. El diálogo de reserva para varias
   * personas construye sus `<select>` y sus `<input type="radio">` en el JS
   * (no vienen del HTML servido, porque su número lo decide el operador), así
   * que la única forma de ejercitar "elegir un servicio" o "marcar una
   * propuesta" sin navegador es llamar a este manejador. No emula NADA más del
   * modelo de eventos: ni captura, ni burbujeo, ni `target`.
   */
  onchange: (() => void) | null = null;
  /**
   * (step 20 §3.7) `oninput` de verdad, gemelo de `onchange`: la nota corta
   * del taller de decisiones asigna su manejador por PROPIEDAD (D20-51) y la
   * única forma de ejercitar «teclear en la nota» sin navegador es llamarlo.
   * No emula nada más del modelo de eventos.
   */
  oninput: (() => void) | null = null;
  type = "";
  /**
   * (revisión step 15, D6) `disabled` de verdad, el que ui.js.ts pone y lee
   * ahora en los botones de publicar en vez de un `aria-disabled` decorativo.
   */
  disabled = false;
  /** El valor de un `<select>`/`<input>`, que `ensureProfessionalOptions` lee y escribe. */
  value = "";
  /**
   * Puesto por `FakeDocument.createElement`/`seed`, para que `focus()` pueda
   * mover `document.activeElement` igual que en un navegador — necesario para
   * probar que ocultar el detalle de una llamada no deja el foco en el vacío
   * (step 15).
   */
  ownerDocument: FakeDocument | null = null;
  /**
   * (step 16, O4) `<dialog open>` — el ESTADO del atributo, y nada más.
   * NO hay top layer, NI backdrop, NI trampa de foco, NI el Escape NATIVO que
   * un <dialog> abierto se come antes de que llegue al documento, NI evento
   * `close`, NI `returnValue`. Todo eso lo hace el navegador y sólo se puede
   * comprobar en el Mac (ver el runbook). Lo que SÍ permite esto es lo único
   * que el código de ui.js.ts decide por su cuenta: si hay un diálogo
   * abierto, el manejador de Escape del documento se aparta.
   */
  open = false;
  /**
   * (step 17) El estado de un `<input type="radio">`. Lo escribe y lo lee
   * el bloque de lista de espera para que la elección de una persona
   * sobreviva al sondeo — y para que la AUSENCIA de elección (ningún radio
   * marcado, §5.1) sea comprobable.
   */
  checked = false;
  /** (step 17) El `name` que agrupa un conjunto de radios. */
  name = "";

  private ownListeners = new Map<string, Array<(ev?: unknown) => void>>();

  /**
   * (step 17) Escuchar en un ELEMENTO, no sólo en el documento. Hace falta
   * para el evento `close` de un `<dialog>`, que es donde la consola
   * devuelve el foco a quien lo abrió: enganchado ahí y no al botón de
   * cerrar, el foco vuelve TAMBIÉN cuando cierra el Escape nativo.
   */
  addEventListener(type: string, handler: (ev?: unknown) => void): void {
    const list = this.ownListeners.get(type) ?? [];
    list.push(handler);
    this.ownListeners.set(type, list);
  }

  /**
   * (step 18, fase G) Emite un `change` SINTÉTICO sobre este elemento. NO es
   * un evento del DOM: no hay captura, ni burbujeo, ni `preventDefault`, ni el
   * orden real entre manejadores. Sólo llama, en orden de registro, a los que
   * se engancharon con `addEventListener('change', …)`, pasándoles un objeto
   * con `target` — que es lo único que lee el código real. Hace falta para
   * poder marcar el `radiogroup` de "cómo quieren las citas", que vive en el
   * HTML servido y por tanto se cablea así y no con `onchange`.
   */
  dispatchChange(): void {
    for (const handler of this.ownListeners.get("change") ?? []) handler({ target: this });
  }

  /**
   * (step 19 Capacidad 2) Emite un `click` SINTÉTICO sobre este elemento. Los
   * tres botones de estado del historial de tareas humanas (Laboratorio) se
   * enganchan con `addEventListener('click', …)` — no con `.onclick` — así
   * que hace falta este método, gemelo de `dispatchChange`, para poder
   * comprobar la selección de filtro sin navegador. NO es un evento del DOM:
   * no hay captura, ni burbujeo, ni `preventDefault`.
   */
  dispatchClick(): void {
    for (const handler of this.ownListeners.get("click") ?? []) handler({ target: this });
  }

  showModal(): void {
    this.open = true;
  }

  /**
   * Cierra y emite `close`, como el elemento real. NO emula nada más del
   * `<dialog>` nativo: ni top layer, ni backdrop, ni trampa de foco, ni el
   * Escape que el navegador se come antes de que llegue al documento. Lo que
   * sí permite es comprobar lo único que decide la consola: qué pasa con el
   * foco DESPUÉS de que un diálogo se cierre, venga el cierre de un botón o
   * de la tecla Escape (que en un navegador acaba, exactamente, aquí).
   */
  close(): void {
    this.open = false;
    for (const handler of this.ownListeners.get("close") ?? []) handler();
  }

  private attrs = new Map<string, string>();
  private classes = new Set<string>();
  private text = "";

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }

  get classList(): { add: (c: string) => void; remove: (c: string) => void; toggle: (c: string, force?: boolean) => void; contains: (c: string) => boolean } {
    const self = this;
    return {
      add: (c: string) => {
        self.classes.add(c);
      },
      remove: (c: string) => {
        self.classes.delete(c);
      },
      toggle: (c: string, force?: boolean) => {
        const want = force === undefined ? !self.classes.has(c) : force;
        if (want) self.classes.add(c);
        else self.classes.delete(c);
      },
      contains: (c: string) => self.classes.has(c),
    };
  }

  get textContent(): string {
    if (this.children.length === 0) return this.text;
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  /** Las `<option>` de un `<select>`, como las lee `ensureProfessionalOptions`. */
  get options(): FakeElement[] {
    return this.children.filter((c) => c.tagName === "OPTION");
  }

  get nextSibling(): FakeElement | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return this.parentNode.children[idx + 1] ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement {
    if (child.parentNode) child.parentNode.removeChild(child);
    if (ref === null) {
      this.children.push(child);
    } else {
      const idx = this.children.indexOf(ref);
      if (idx === -1) throw new Error("insertBefore: nodo de referencia no encontrado en el DOM falso");
      this.children.splice(idx, 0, child);
    }
    child.parentNode = this;
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      this.blurIfDetached(child);
    }
    child.parentNode = null;
    return child;
  }

  /**
   * (step 16, O3) Un navegador PIERDE el foco cuando el nodo que lo contiene
   * se desconecta del documento — y mover un nodo con `insertBefore` es
   * exactamente eso: desconectar y volver a conectar. Sin esto, una prueba de
   * "el sondeo no me roba el foco" no podría fallar nunca.
   *
   * NO se emula nada más del modelo de foco: ni orden de tabulación, ni
   * `tabindex`, ni que el destino real sea `<body>` (aquí el foco perdido es
   * `null`), ni los eventos `blur`/`focusout`. Es lo mínimo para que la
   * pérdida de foco sea OBSERVABLE, no un navegador de mentira.
   */
  private blurIfDetached(child: FakeElement): void {
    const doc = this.ownerDocument ?? child.ownerDocument;
    if (!doc) return;
    if (child.contains(doc.activeElement)) doc.activeElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) ?? null) : null;
  }

  /**
   * ¿Sigue este nodo DENTRO del documento?
   *
   * Existe porque `ui.js.ts` pregunta exactamente esto antes de devolverle el
   * foco al botón que abrió un diálogo, y la pregunta correcta NO es
   * `parentNode`: un nodo que se quita junto con su subárbol conserva su padre
   * —desprendido— y pasaría por vivo. En estos documentos de prueba «estar en
   * el documento» significa ser un nodo sembrado por `seed()` o descender de
   * uno, que es la única raíz que este doble modela.
   */
  get isConnected(): boolean {
    const doc = this.ownerDocument;
    if (!doc) return false;
    let cur: FakeElement | null = this;
    while (cur !== null) {
      if (doc.estaSembrado(cur)) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  contains(node: FakeElement | null): boolean {
    if (!node) return false;
    let cur: FakeElement | null = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  /** Mueve el foco del documento a este elemento, como haría un navegador. */
  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  /**
   * Sólo soporta los dos selectores que las funciones probadas usan de
   * verdad: `[data-xxx="valor"]` (el aviso de temporada de Equipo) y un
   * nombre de etiqueta suelto, p. ej. `a` (el enlace "Ver" de cada fila de
   * Llamadas). Cualquier otro selector lanza, para que un cambio en la
   * interfaz no pase inadvertido aquí dentro.
   */
  querySelector(selector: string): FakeElement | null {
    const trimmed = selector.trim();
    const dataMatch = /^\[data-([a-z-]+)="([^"]*)"\]$/.exec(trimmed);
    const tagMatch = /^[a-z][a-z0-9]*$/.exec(trimmed);
    if (!dataMatch && !tagMatch) throw new Error(`selector no soportado por el DOM de prueba: ${selector}`);
    const stack: FakeElement[] = [...this.children];
    while (stack.length > 0) {
      const node = stack.shift();
      if (!node) continue;
      if (dataMatch) {
        if (node.getAttribute(`data-${dataMatch[1]}`) === dataMatch[2]) return node;
      } else if (node.tagName === trimmed.toUpperCase()) {
        return node;
      }
      stack.push(...node.children);
    }
    return null;
  }
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  /** `applyRoute()` escribe aquí el título de la pestaña. */
  title = "";
  private byId = new Map<string, FakeElement>();

  /**
   * (revisión step 15 / step 16, O4) `applyRoute()` busca el enlace de
   * navegación activo (`a[data-route="..."]`) — eso no existe nunca en estos
   * documentos de prueba, y el código real ya trata el `null` como respuesta
   * correcta, no un atajo. `dialog[open]` SÍ se resuelve de verdad desde
   * step 16: mira los nodos sembrados por `seed()` y devuelve el primero
   * cuya etiqueta sea `DIALOG` y cuyo `.open` sea `true` — el mismo criterio
   * que un navegador aplicaría al `<dialog open>` real. Cualquier OTRO
   * selector lanza, para que un cambio en la interfaz no pase inadvertido
   * aquí dentro.
   */
  querySelector(selector: string): FakeElement | null {
    // El guion entra por `lista-espera` (step 17): el enrutador pregunta por
    // `a[data-route="lista-espera"]` igual que por las seis rutas anteriores.
    // Sigue devolviendo null —esos enlaces no existen en estos documentos de
    // prueba— y sigue lanzando ante cualquier OTRO selector.
    if (/^a\[data-route="[a-z-]+"\]$/.test(selector)) return null;
    if (selector === "dialog[open]") {
      for (const node of this.byId.values()) {
        if (node.tagName === "DIALOG" && node.open) return node;
      }
      return null;
    }
    throw new Error(`selector de documento no soportado por el DOM de prueba: ${selector}`);
  }

  /** Registra un elemento ya creado bajo un id, igual que un `<div id="...">` en el HTML servido. */
  seed(id: string, tag = "div"): FakeElement {
    const node = new FakeElement(tag);
    node.ownerDocument = this;
    node.setAttribute("id", id);
    this.byId.set(id, node);
    return node;
  }

  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }

  /** La raíz que este doble modela: los nodos sembrados son «el documento». */
  estaSembrado(node: FakeElement): boolean {
    for (const sembrado of this.byId.values()) {
      if (sembrado === node) return true;
    }
    return false;
  }

  createElement(tag: string): FakeElement {
    const node = new FakeElement(tag);
    node.ownerDocument = this;
    return node;
  }

  /**
   * (step 16, O4) El propio ui.js.ts registra un listener de 'keydown' a
   * nivel de módulo — hasta ahora era no-op porque ninguna prueba disparaba
   * ningún evento. Desde step 16 SÍ se guarda, para poder emitir un
   * `keydown` sintético con `dispatchKeydown()` y comprobar que la rama de
   * Escape de ese manejador hace lo que dice.
   */
  private listeners = new Map<string, Array<(ev: { key: string }) => void>>();

  addEventListener(type: string, handler: (ev: { key: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  /**
   * (step 16, O4) Emite un keydown SINTÉTICO. NO es un evento del DOM: no
   * hay fase de captura ni de burbujeo, ni `target`, ni `preventDefault`, ni
   * `defaultPrevented`, ni el orden real entre el <dialog> nativo y este
   * manejador. Sólo llama, en orden de registro, a los manejadores de
   * `keydown` que ui.js.ts instaló en el DOCUMENTO. Lo que este método NO
   * puede demostrar está enumerado en el runbook del Mac.
   */
  dispatchKeydown(key: string): void {
    for (const handler of this.listeners.get("keydown") ?? []) handler({ key });
  }
}

/**
 * Construye el `document` falso con exactamente los contenedores que
 * `renderEquipo()` busca por id en el HTML real (`src/console/ui.html.ts`:
 * `#equipo-fichas`, `#equipo-vacio`, y desde step 16 (O5) también
 * `#equipo-horario-regimen` y `#equipo-horario-dias`, el bloque de horario
 * del local que ahora vive una sola vez arriba de Equipo).
 */
export function createEquipoFakeDocument(): { document: FakeDocument; fichas: FakeElement; vacio: FakeElement } {
  const document = new FakeDocument();
  const fichas = document.seed("equipo-fichas", "div");
  const vacio = document.seed("equipo-vacio", "div");
  vacio.hidden = true;
  document.seed("equipo-horario-regimen", "p");
  document.seed("equipo-horario-dias", "ul");
  return { document, fichas, vacio };
}

/**
 * (step 15) Un `document` falso con exactamente los ids que la función que
 * se va a probar busca en el HTML real. Se pasa la lista explícita en cada
 * prueba: si `ui.js.ts` empezara a leer un id que no está aquí, `byId()`
 * devolvería `null` y la prueba fallaría con un error claro, nunca en
 * silencio.
 */
export function createFakeDocumentWithIds(
  ids: readonly (string | { id: string; tag: string })[],
): { document: FakeDocument; nodes: Record<string, FakeElement> } {
  const document = new FakeDocument();
  const nodes: Record<string, FakeElement> = {};
  for (const entry of ids) {
    const id = typeof entry === "string" ? entry : entry.id;
    const tag = typeof entry === "string" ? "div" : entry.tag;
    nodes[id] = document.seed(id, tag);
  }
  return { document, nodes };
}
