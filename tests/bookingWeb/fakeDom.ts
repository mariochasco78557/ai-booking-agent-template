/**
 * Un DOM falso MÍNIMO, escrito a mano, para ejecutar el JavaScript REAL
 * servido por `GET /app.js` (`src/bookingWeb/ui.js.ts`, vía
 * `loadUiClientHooks` en `uiClientExtract.ts`) sin un navegador de verdad.
 *
 * Calca el patrón de `tests/console/fakeDom.ts` (que esta misión prohíbe
 * importar) pero es un fichero PROPIO de `tests/bookingWeb/`, recortado a lo
 * que la interfaz de reservas usa de verdad: `createElement`,
 * `getElementById`, `appendChild`/`insertBefore`/`removeChild`, `classList`,
 * atributos, `checked`/`disabled`/`value`/`type` de formulario, un
 * `<dialog>` con `showModal()`/`close()`, y clics/cambios sintéticos.
 *
 * No pretende ser un DOM completo — sólo lo que hace falta para probar la
 * lógica real de `ui.js.ts` sin instalar jsdom/happy-dom/puppeteer.
 *
 * AMPLIACIÓN 2026-08-26 (defecto de la página inerte). Este motor ya no se
 * alimenta sólo de nodos escritos a mano: `htmlParse.ts` construye estas
 * mismas clases ANALIZANDO el HTML REAL que sirve el servidor. Para que eso
 * sea fiel hicieron falta tres cosas, todas compatibles con quien ya usaba el
 * fichero:
 *   - NODOS DE TEXTO. `childNodes` guarda todos los hijos (texto incluido) y
 *     `children` pasa a ser una vista que sólo devuelve ELEMENTOS, igual que
 *     el DOM de verdad — si no, los saltos de línea del HTML se colarían en
 *     `byId('txb-steps').children` y romperían el indicador de pasos.
 *   - `hidden` y `disabled` REFLEJADOS en el atributo, como manda el HTML:
 *     leer la propiedad y consultar el atributo dan siempre lo mismo, así que
 *     un `<section hidden>` del documento servido nace oculto de verdad.
 *   - `querySelector`/`querySelectorAll` con selectores SIMPLES (etiqueta,
 *     `#id`, `.clase`, `[attr]`, `[attr="valor"]` y sus combinaciones, con
 *     comas). Sin combinadores ni pseudoclases: lo justo para localizar el
 *     `<script>` de la página o una ficha por su clase.
 *
 * AMPLIACIÓN M-WEB-1 (2026-08-26) — teclado, foco y visibilidad. La web
 * pública añade tres comportamientos que un clic no alcanza: el cierre con
 * `Escape`, la devolución del foco al elemento que abrió un panel y la
 * pregunta «¿puede el teclado llegar hasta aquí?». Este motor gana lo mínimo
 * para poder probarlos SIN inventarse nada que un navegador no haga:
 *
 *   - `dispatchKeydown(key)` en elemento y en documento, con un evento que
 *     BURBUJEA por los ancestros hasta el documento, como el de verdad.
 *   - `dispatchFocus()` / `dispatchBlur()`, y `focus()` que además avisa a
 *     quien escuche `focus`.
 *   - `Escape` cierra SOLO un `<dialog open>`, y sólo cuando el evento llega
 *     al documento. Es lo que hace el navegador con el elemento nativo. Para
 *     un `<div>` de menú NO se emula: ahí el cierre es responsabilidad de la
 *     aplicación y precisamente por eso hay que probarlo.
 *   - `esVisibleParaElTeclado` / `esTabulable` / `ordenDeTabulacion`.
 *
 * LO QUE ESTE MOTOR NO MODELA, y conviene tener presente al escribir una
 * prueba: un `<dialog>` CERRADO no oculta su contenido aquí (en un navegador
 * es `display:none`), y `showModal()` no vuelve inerte el resto del documento
 * ni mueve el foco. Lo primero es una limitación conocida —ninguna prueba de
 * esta suite deduce nada de la tabulación dentro de un cajón cerrado—; lo
 * segundo es deliberado: se exige por contrato que la aplicación enfoque
 * explícitamente lo que toque, y así el foco es observable y determinista.
 */

/** Etiqueta interna de un nodo de texto (el DOM real usa `#text`). */
export const TEXT_NODE_TAG = "#TEXT";

/**
 * Un evento de teclado sintético, con lo justo que lee `ui.js.ts`: la tecla,
 * el objetivo y las dos formas de cortar el curso normal del evento.
 */
export interface FakeKeyboardEvent {
  key: string;
  target: FakeElement | FakeDocument | null;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

function nuevoEventoDeTecla(key: string, target: FakeElement | FakeDocument | null): FakeKeyboardEvent {
  const ev: FakeKeyboardEvent = {
    key,
    target,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault: () => {
      ev.defaultPrevented = true;
    },
    stopPropagation: () => {
      ev.propagationStopped = true;
    },
  };
  return ev;
}

export class FakeElement {
  readonly tagName: string;
  /** TODOS los hijos, nodos de texto incluidos (equivale a `childNodes`). */
  childNodes: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  ownerDocument: FakeDocument | null = null;

  checked = false;
  value = "";
  type = "";
  name = "";
  open = false;

  private attrs = new Map<string, string>();
  private classes = new Set<string>();
  private text = "";
  private listeners = new Map<string, Array<(ev?: unknown) => void>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  /** ¿Es este nodo un nodo de texto? */
  get isTextNode(): boolean {
    return this.tagName === TEXT_NODE_TAG;
  }

  /**
   * Sólo los hijos ELEMENTO, como `Element.children` en un navegador. Es una
   * vista calculada: los nodos se añaden y se quitan con
   * `appendChild`/`insertBefore`/`removeChild`, nunca tocando esta lista.
   */
  get children(): FakeElement[] {
    return this.childNodes.filter((n) => !n.isTextNode);
  }

  /** `hidden` es un atributo booleano reflejado, igual que en el HTML real. */
  get hidden(): boolean {
    return this.attrs.has("hidden");
  }
  set hidden(value: boolean) {
    if (value) this.attrs.set("hidden", "");
    else this.attrs.delete("hidden");
  }

  /** `disabled` también se refleja en el atributo. */
  get disabled(): boolean {
    return this.attrs.has("disabled");
  }
  set disabled(value: boolean) {
    if (value) this.attrs.set("disabled", "");
    else this.attrs.delete("disabled");
  }

  get className(): string {
    return [...this.classes].join(" ");
  }
  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }
  get classList(): {
    add: (c: string) => void;
    remove: (c: string) => void;
    toggle: (c: string, force?: boolean) => void;
    contains: (c: string) => boolean;
  } {
    const self = this;
    return {
      add: (c) => {
        self.classes.add(c);
      },
      remove: (c) => {
        self.classes.delete(c);
      },
      toggle: (c, force) => {
        const want = force === undefined ? !self.classes.has(c) : force;
        if (want) self.classes.add(c);
        else self.classes.delete(c);
      },
      contains: (c) => self.classes.has(c),
    };
  }

  get textContent(): string {
    if (this.childNodes.length === 0) return this.text;
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
  }

  get firstChild(): FakeElement | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): FakeElement | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement {
    if (child.parentNode) child.parentNode.removeChild(child);
    if (ref === null) {
      this.childNodes.push(child);
    } else {
      const idx = this.childNodes.indexOf(ref);
      if (idx === -1) throw new Error("insertBefore: nodo de referencia no encontrado en el DOM falso");
      this.childNodes.splice(idx, 0, child);
    }
    child.parentNode = this;
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }

  /** Todos los descendientes ELEMENTO, en orden de documento. */
  descendants(): FakeElement[] {
    const salida: FakeElement[] = [];
    for (const child of this.childNodes) {
      if (child.isTextNode) continue;
      salida.push(child);
      salida.push(...child.descendants());
    }
    return salida;
  }

  /** Ver el docblock de cabecera: selectores SIMPLES, sin combinadores. */
  querySelectorAll(selector: string): FakeElement[] {
    const grupos = parseSimpleSelector(selector);
    return this.descendants().filter((node) => grupos.some((g) => matchesSimpleSelector(node, g)));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) ?? null) : null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  getAttributeNames(): string[] {
    return [...this.attrs.keys()];
  }

  addEventListener(type: string, handler: (ev?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  /**
   * Emite un `click` sintético: sólo llama a los manejadores registrados con
   * `addEventListener('click', …)`.
   *
   * Un elemento DESHABILITADO se traga el clic sin avisar, igual que en un
   * navegador de verdad. Si no fuera así, una prueba podría "pulsar" un botón
   * que la persona no puede pulsar y dar por buena una interfaz atascada.
   */
  dispatchClick(): void {
    if (this.disabled) return;
    for (const handler of this.listeners.get("click") ?? []) handler({ target: this });
  }

  /** Emite un `change` sintético (radios, checkbox, `<select>`). */
  dispatchChange(): void {
    for (const handler of this.listeners.get("change") ?? []) handler({ target: this });
  }

  /** Llama a los manejadores de `tipo` de ESTE nodo con el evento dado. */
  entregar(tipo: string, ev: FakeKeyboardEvent): void {
    for (const handler of this.listeners.get(tipo) ?? []) {
      handler(ev);
      if (ev.propagationStopped) return;
    }
  }

  /**
   * Emite un `keydown` sintético que BURBUJEA: primero este nodo, después cada
   * ancestro y por último el documento. Es como llega la tecla en un navegador,
   * y por eso un manejador registrado en `document` —como el `Escape` del menú
   * móvil— se entera de una tecla pulsada dentro de un enlace del panel.
   */
  dispatchKeydown(key: string): FakeKeyboardEvent {
    const ev = nuevoEventoDeTecla(key, this);
    for (let n: FakeElement | null = this; n !== null; n = n.parentNode) {
      n.entregar("keydown", ev);
      if (ev.propagationStopped) return ev;
    }
    this.ownerDocument?.recibirKeydownDeUnDescendiente(ev);
    return ev;
  }

  /** Enfoca y avisa: `activeElement` pasa a ser este nodo y se emite `focus`. */
  dispatchFocus(): void {
    this.focus();
  }

  /** Retira el foco de este nodo (si lo tenía) y emite `blur`. */
  dispatchBlur(): void {
    const doc = this.ownerDocument;
    if (doc && doc.activeElement === this) doc.activeElement = null;
    this.entregar("blur", nuevoEventoDeTecla("", this));
  }

  showModal(): void {
    if (this.open) return;
    this.open = true;
    this.ownerDocument?.apilarDialogoAbierto(this);
  }
  close(): void {
    const estaba = this.open;
    this.open = false;
    this.ownerDocument?.desapilarDialogoAbierto(this);
    if (!estaba) return;
    for (const handler of this.listeners.get("close") ?? []) handler();
  }

  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
    this.entregar("focus", nuevoEventoDeTecla("", this));
  }
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  readyState = "loading";
  body: FakeElement;
  /** El `<html>` del documento analizado, si el documento viene de `htmlParse.ts`. */
  documentElement: FakeElement | null = null;
  /** El `<head>` del documento analizado, si lo hay. */
  head: FakeElement | null = null;

  private byId = new Map<string, FakeElement>();
  private listeners = new Map<string, Array<(ev?: unknown) => void>>();
  /** Los `<dialog>` abiertos con `showModal()`, del más antiguo al de encima. */
  private dialogosAbiertos: FakeElement[] = [];

  constructor() {
    this.body = new FakeElement("body");
    this.body.ownerDocument = this;
  }

  createElement(tag: string): FakeElement {
    const node = new FakeElement(tag);
    node.ownerDocument = this;
    return node;
  }

  createTextNode(text: string): FakeElement {
    const node = new FakeElement(TEXT_NODE_TAG);
    node.ownerDocument = this;
    node.textContent = text;
    return node;
  }

  /**
   * Da de alta un elemento YA construido en el índice de ids del documento.
   * Lo usa `htmlParse.ts` según va cerrando etiquetas: el resultado es el
   * mismo índice que `seed()` rellena a mano, pero salido del HTML real.
   */
  registerById(id: string, node: FakeElement): void {
    if (this.byId.has(id)) {
      throw new Error(`El documento analizado repite el id «${id}»: en el DOM real sólo ganaría el primero.`);
    }
    this.byId.set(id, node);
  }

  /** Busca en todo el documento (ver los selectores admitidos en la cabecera). */
  querySelectorAll(selector: string): FakeElement[] {
    const raiz = this.documentElement ?? this.body;
    const grupos = parseSimpleSelector(selector);
    const propios = grupos.some((g) => matchesSimpleSelector(raiz, g)) ? [raiz] : [];
    return [...propios, ...raiz.querySelectorAll(selector)];
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Registra un elemento ya creado bajo un id, igual que un `<div id="…">` del HTML servido. */
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

  /** Los ids que este documento conoce, en orden de alta. */
  ids(): string[] {
    return [...this.byId.keys()];
  }

  addEventListener(type: string, handler: (ev?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatchDOMContentLoaded(): void {
    for (const handler of this.listeners.get("DOMContentLoaded") ?? []) handler();
  }

  /** Lo llama `showModal()`. Ver `dispatchKeydown`. */
  apilarDialogoAbierto(dialog: FakeElement): void {
    this.dialogosAbiertos.push(dialog);
  }

  /** Lo llama `close()`. */
  desapilarDialogoAbierto(dialog: FakeElement): void {
    this.dialogosAbiertos = this.dialogosAbiertos.filter((d) => d !== dialog);
  }

  /** El `<dialog>` que está encima de todos, o `null` si no hay ninguno abierto. */
  dialogoEnCima(): FakeElement | null {
    return this.dialogosAbiertos[this.dialogosAbiertos.length - 1] ?? null;
  }

  /**
   * Una tecla pulsada en el documento. El objetivo es el elemento enfocado, si
   * lo hay, igual que en un navegador.
   */
  dispatchKeydown(key: string): FakeKeyboardEvent {
    const ev = nuevoEventoDeTecla(key, this.activeElement ?? this);
    for (const handler of this.listeners.get("keydown") ?? []) {
      handler(ev);
      if (ev.propagationStopped) break;
    }
    this.cerrarDialogoConEscape(ev);
    return ev;
  }

  /** La misma llegada al documento, cuando la tecla venía burbujeando. */
  recibirKeydownDeUnDescendiente(ev: FakeKeyboardEvent): void {
    if (!ev.propagationStopped) {
      for (const handler of this.listeners.get("keydown") ?? []) {
        handler(ev);
        if (ev.propagationStopped) break;
      }
    }
    this.cerrarDialogoConEscape(ev);
  }

  /**
   * `Escape` CIERRA UN `<dialog open>`, y nada más.
   *
   * Lo hace el navegador con el elemento nativo, así que emularlo evita exigirle
   * a la aplicación un código que no necesita escribir. Un `<div>` que hace de
   * menú NO se cierra aquí a propósito: ahí el cierre con `Escape` es
   * responsabilidad de quien lo programa, y es justo lo que hay que probar.
   */
  private cerrarDialogoConEscape(ev: FakeKeyboardEvent): void {
    if (ev.key !== "Escape" || ev.defaultPrevented) return;
    const dialog = this.dialogoEnCima();
    if (dialog) dialog.close();
  }
}

/**
 * ¿PUEDE EL TECLADO LLEGAR HASTA ESTE NODO?
 *
 * Sube por `parentNode` y descarta el nodo si él o cualquier ancestro está
 * `hidden`, `inert` o marcado `aria-hidden="true"`. Hace falta subir porque en
 * este motor `hidden` no cascadea solo: un enlace perfectamente visible dentro
 * de un `<div hidden>` seguiría pareciendo alcanzable.
 *
 * `txb-visually-hidden` NO descarta, y es la parte importante: esa clase oculta
 * a la vista pero mantiene el nodo en el árbol y en la secuencia de tabulación.
 * El enlace de saltar al contenido vive así —invisible hasta que recibe el
 * foco— y descartarlo aquí convertiría la prueba del primer tabulable en una
 * mentira.
 */
export function esVisibleParaElTeclado(node: FakeElement): boolean {
  for (let n: FakeElement | null = node; n !== null; n = n.parentNode) {
    if (n.isTextNode) continue;
    if (n.getAttribute("hidden") !== null) return false;
    if (n.getAttribute("inert") !== null) return false;
    if (n.getAttribute("aria-hidden") === "true") return false;
  }
  return true;
}

/** Las etiquetas que un navegador mete en la secuencia de tabulación por sí solas. */
const ETIQUETAS_TABULABLES = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);

/**
 * ¿Está este nodo en la secuencia de tabulación? Un `tabindex` negativo lo
 * saca, `disabled` lo saca, un ancestro oculto lo saca, un `tabindex` de cero o
 * más lo mete aunque no sea un control, y un `<a>` sin `href` no cuenta.
 */
export function esTabulable(node: FakeElement): boolean {
  if (node.isTextNode) return false;
  if (node.disabled) return false;
  if (!esVisibleParaElTeclado(node)) return false;
  const tabindex = node.getAttribute("tabindex");
  if (tabindex !== null) {
    const valor = Number(tabindex);
    if (!Number.isNaN(valor)) return valor >= 0;
  }
  if (node.tagName === "A") return node.getAttribute("href") !== null;
  return ETIQUETAS_TABULABLES.has(node.tagName);
}

/** Los tabulables del `<body>`, en ORDEN DE DOCUMENTO. */
export function ordenDeTabulacion(document: FakeDocument): FakeElement[] {
  return document.body.descendants().filter((n) => esTabulable(n));
}

/**
 * Un selector SIMPLE ya descompuesto: etiqueta, id, clases y atributos. No hay
 * combinadores (` `, `>`, `+`) ni pseudoclases a propósito — un selector que
 * este motor no entienda revienta al analizarlo, nunca devuelve una lista
 * vacía en silencio.
 */
interface SelectorSimple {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: Array<{ name: string; value: string | null }>;
}

const TROZO_SELECTOR = /^(?:([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\])/;

function parseSimpleSelector(selector: string): SelectorSimple[] {
  return selector
    .split(",")
    .map((parte) => parte.trim())
    .filter((parte) => parte.length > 0)
    .map((parte) => {
      const salida: SelectorSimple = { tag: null, id: null, classes: [], attrs: [] };
      let resto = parte;
      while (resto.length > 0) {
        const m = TROZO_SELECTOR.exec(resto);
        if (!m) {
          throw new Error(
            `Selector no admitido por el DOM falso: «${selector}». Sólo etiqueta, #id, .clase y [attr] o [attr="valor"], sin combinadores.`,
          );
        }
        if (m[1] !== undefined) salida.tag = m[1].toUpperCase();
        else if (m[2] !== undefined) salida.id = m[2];
        else if (m[3] !== undefined) salida.classes.push(m[3]);
        else if (m[4] !== undefined) {
          const valor = m[5] ?? m[6] ?? m[7] ?? null;
          salida.attrs.push({ name: m[4], value: valor });
        }
        resto = resto.slice(m[0].length);
      }
      return salida;
    });
}

function matchesSimpleSelector(node: FakeElement, sel: SelectorSimple): boolean {
  if (node.isTextNode) return false;
  if (sel.tag !== null && node.tagName !== sel.tag) return false;
  if (sel.id !== null && node.getAttribute("id") !== sel.id) return false;
  for (const clase of sel.classes) {
    if (!node.classList.contains(clase)) return false;
  }
  for (const attr of sel.attrs) {
    const actual = node.getAttribute(attr.name);
    if (actual === null) return false;
    if (attr.value !== null && actual !== attr.value) return false;
  }
  return true;
}

/*
 * AQUÍ VIVÍA `createBookingFakeDocument`, Y SE HA BORRADO A PROPÓSITO
 * (M-WEB-1, 2026-08-26).
 *
 * Era un documento INVENTADO con unos cincuenta identificadores escritos a
 * mano, contra el que se ejecutaba el cliente real en `uiFlujo.test.ts`. Ese
 * documento podía alejarse del HTML servido por tres puertas, y sólo una
 * estaba vigilada:
 *   1. IDS que el cliente lee y la plantilla no emite. El guardián sólo
 *      recorría lo que había en el documento inventado, así que un `byId`
 *      nuevo sin entrada aquí no lo miraba nadie.
 *   2. ATRIBUTOS. El guardián comparaba la etiqueta y nada más: un
 *      `<section hidden>` real frente a un nodo visible cambia el
 *      comportamiento sin que nadie se entere.
 *   3. ESTRUCTURA. Los nodos nacían SUELTOS, sin padre, así que ninguna
 *      prueba de orden, anidamiento, ancestros ocultos o foco podía escribirse
 *      contra él — y, peor, una escrita contra él habría pasado afirmando algo
 *      que en la página real es falso.
 *
 * Lo sustituyen dos cosas, las dos más fuertes: `parseHtmlDocument(html, {
 * readyState: "loading" })` sobre el HTML REALMENTE SERVIDO, que cierra las
 * tres puertas de una vez, y `contratoDeIdentificadores.test.ts`, que recupera
 * el inventario de identificadores DERIVÁNDOLO del propio cliente en lugar de
 * mantenerlo a mano — que es justo el tipo de lista que se desincroniza.
 */
