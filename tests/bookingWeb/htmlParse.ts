import { FakeDocument, FakeElement } from "./fakeDom.js";

/**
 * ────────────────────────────────────────────────────────────────────────
 * UN ANALIZADOR DE HTML MÍNIMO, PROPIO Y SIN DEPENDENCIAS.
 *
 * POR QUÉ EXISTE. Hasta 2026-08-26 las pruebas de flujo de la demostración
 * web ejecutaban el cliente real contra un documento ESCRITO A MANO
 * (`createBookingFakeDocument` en `fakeDom.ts`), es decir, contra un modelo
 * mental del HTML en vez de contra el HTML. Ese modelo tenía todos los nodos,
 * así que 93 pruebas en verde no vieron que la página servida NO REFERENCIABA
 * el script: `renderBookingHtml()` no emitía ninguna etiqueta `<script>` y la
 * página real quedaba completamente inerte. Mientras el DOM de prueba se
 * escriba a mano, ese agujero sigue abierto. Este fichero lo cierra: construye
 * el DOM falso ANALIZANDO el HTML que sirve el servidor, byte a byte.
 *
 * NO SE AÑADE NINGUNA DEPENDENCIA (ni jsdom, ni happy-dom, ni cheerio): el
 * HTML de `src/bookingWeb/ui.html.ts` es una plantilla propia, bien formada y
 * escrita a mano, y basta con un tokenizador pequeño.
 *
 * QUÉ ENTIENDE:
 *   - `<!DOCTYPE …>` y comentarios `<!-- … -->` (se ignoran).
 *   - etiquetas de apertura con atributos entrecomillados con `"`, con `'` o
 *     sin comillas, y atributos booleanos sin valor (`hidden`, `disabled`,
 *     `defer`).
 *   - elementos vacíos (`meta`, `link`, `img`, `input`, `br`, `hr`, `col`…) y
 *     la forma autocerrada `<x />`.
 *   - elementos de TEXTO CRUDO (`script`, `style`): su contenido no se analiza,
 *     se lee tal cual hasta la etiqueta de cierre.
 *   - nodos de texto, con las entidades básicas descodificadas.
 *
 * QUÉ NO ENTIENDE, A PROPÓSITO: cierres implícitos (`<li>` sin `</li>`),
 * `<template>`, secciones CDATA, mayúsculas raras en las etiquetas de cierre.
 * Cualquier cosa que no cuadre LANZA un error con la posición: si mañana la
 * plantilla se malforma, esto se entera; no adivina.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Elementos sin contenido: nunca abren nivel en la pila. */
const ELEMENTOS_VACIOS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elementos cuyo contenido es texto crudo y no se analiza como marcado. */
const ELEMENTOS_TEXTO_CRUDO = new Set(["script", "style"]);

/**
 * Atributos booleanos que en el DOM real se reflejan en una PROPIEDAD del
 * elemento. `hidden` y `disabled` los refleja ya `FakeElement`; `checked` y
 * `open` son campos sueltos y hay que copiarlos al analizar.
 */
const PROPIEDADES_DE_CADENA = new Set(["type", "name", "value"]);

const ENTIDADES: Array<[RegExp, string]> = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&apos;/g, "'"],
  [/&nbsp;/g, " "],
  // `&amp;` va el ÚLTIMO: si fuera el primero, «&amp;lt;» acabaría siendo «<».
  [/&amp;/g, "&"],
];

function decodificarEntidades(texto: string): string {
  let salida = texto;
  for (const [patron, valor] of ENTIDADES) salida = salida.replace(patron, valor);
  return salida;
}

interface AtributoLeido {
  name: string;
  /** `null` cuando el atributo venía sin `=` (atributo booleano). */
  value: string | null;
}

/** Resultado de leer una etiqueta de apertura. */
interface EtiquetaLeida {
  tag: string;
  attrs: AtributoLeido[];
  autocerrada: boolean;
  /** Posición del carácter siguiente al `>` de la etiqueta. */
  fin: number;
}

const NOMBRE_ETIQUETA = /^[a-zA-Z][\w:-]*/;
const NOMBRE_ATRIBUTO = /^[^\s"'>/=]+/;

function esEspacio(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

function leerEtiquetaApertura(html: string, desde: number): EtiquetaLeida {
  const m = NOMBRE_ETIQUETA.exec(html.slice(desde));
  if (!m) throw new Error(`HTML mal formado: se esperaba un nombre de etiqueta en la posición ${String(desde)}.`);
  const tag = m[0].toLowerCase();
  let i = desde + m[0].length;
  const attrs: AtributoLeido[] = [];
  let autocerrada = false;

  for (;;) {
    while (i < html.length && esEspacio(html[i] as string)) i += 1;
    if (i >= html.length) throw new Error(`HTML mal formado: la etiqueta <${tag}> no se cierra nunca.`);
    if (html[i] === ">") {
      i += 1;
      break;
    }
    if (html.startsWith("/>", i)) {
      autocerrada = true;
      i += 2;
      break;
    }
    const mn = NOMBRE_ATRIBUTO.exec(html.slice(i));
    if (!mn) throw new Error(`HTML mal formado: atributo ilegible en <${tag}>, posición ${String(i)}.`);
    const name = mn[0].toLowerCase();
    i += mn[0].length;
    while (i < html.length && esEspacio(html[i] as string)) i += 1;
    if (html[i] !== "=") {
      attrs.push({ name, value: null });
      continue;
    }
    i += 1;
    while (i < html.length && esEspacio(html[i] as string)) i += 1;
    const comilla = html[i];
    if (comilla === '"' || comilla === "'") {
      const cierre = html.indexOf(comilla, i + 1);
      if (cierre === -1) throw new Error(`HTML mal formado: el atributo «${name}» de <${tag}> no cierra comillas.`);
      attrs.push({ name, value: decodificarEntidades(html.slice(i + 1, cierre)) });
      i = cierre + 1;
    } else {
      let j = i;
      while (j < html.length && !esEspacio(html[j] as string) && html[j] !== ">") j += 1;
      attrs.push({ name, value: decodificarEntidades(html.slice(i, j)) });
      i = j;
    }
  }

  return { tag, attrs, autocerrada, fin: i };
}

function aplicarAtributos(node: FakeElement, attrs: AtributoLeido[], document: FakeDocument): void {
  for (const { name, value } of attrs) {
    if (name === "class") {
      // `class` NO se guarda entre los atributos: la lista viva es `classList`,
      // y tener las dos copias haría que una de ellas mintiera en cuanto el
      // cliente añadiera o quitara una clase.
      node.className = value ?? "";
      continue;
    }
    node.setAttribute(name, value ?? "");
    if (name === "id" && value) document.registerById(value, node);
    if (name === "checked") node.checked = true;
    if (name === "open") node.open = true;
    if (PROPIEDADES_DE_CADENA.has(name)) {
      // `type`/`name`/`value` son propiedades del elemento además de atributos:
      // el cliente lee `input.checked`/`input.type`, no el atributo.
      if (name === "type") node.type = value ?? "";
      else if (name === "name") node.name = value ?? "";
      else node.value = value ?? "";
    }
    // `hidden` y `disabled` no necesitan nada aquí: `FakeElement` los refleja
    // desde el propio atributo que se acaba de poner.
  }
}

/** El estado de carga con el que nace el documento analizado. */
export type EstadoDeCarga = "loading" | "interactive" | "complete";

export interface OpcionesDeAnalisis {
  /**
   * Por defecto `"interactive"`: el estado en el que un navegador ejecuta un
   * `<script defer>` —documento ya analizado, `DOMContentLoaded` todavía sin
   * disparar—, que es exactamente cómo carga esta página, y con el que
   * `ui.js.ts` arranca SOLO.
   *
   * Con `"loading"` el cliente se limita a REGISTRAR `DOMContentLoaded` y no
   * llama a `init()` por su cuenta. Es lo que necesita `loadUiClientHooks`:
   * la prueba arranca cuando quiere, una sola vez, y puede esperar la promesa
   * que devuelve `init()` en vez de competir con una llamada automática.
   *
   * Ese segundo modo es lo que ha permitido borrar `createBookingFakeDocument`:
   * las pruebas de flujo ya no necesitan un documento escrito a mano para poder
   * controlar el arranque; les basta con el HTML REAL analizado en `"loading"`.
   */
  readyState?: EstadoDeCarga;
}

/**
 * Analiza un documento HTML completo y devuelve un `FakeDocument` con
 * `documentElement`, `head`, `body` y el índice de ids ya poblados.
 */
export function parseHtmlDocument(html: string, opciones: OpcionesDeAnalisis = {}): FakeDocument {
  const document = new FakeDocument();
  const pila: FakeElement[] = [];
  let raiz: FakeElement | null = null;
  let i = 0;

  const cima = (): FakeElement | null => pila[pila.length - 1] ?? null;

  const insertar = (node: FakeElement): void => {
    const padre = cima();
    if (padre) padre.appendChild(node);
    else if (raiz === null) raiz = node;
    else throw new Error(`HTML mal formado: hay más de un elemento raíz (<${node.tagName.toLowerCase()}>).`);
  };

  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      const fin = html.indexOf("-->", i + 4);
      if (fin === -1) throw new Error("HTML mal formado: comentario sin cerrar.");
      i = fin + 3;
      continue;
    }
    if (html.startsWith("<!", i)) {
      const fin = html.indexOf(">", i);
      if (fin === -1) throw new Error("HTML mal formado: declaración sin cerrar.");
      i = fin + 1;
      continue;
    }
    if (html.startsWith("</", i)) {
      const fin = html.indexOf(">", i);
      if (fin === -1) throw new Error("HTML mal formado: etiqueta de cierre sin `>`.");
      const tag = html.slice(i + 2, fin).trim().toLowerCase();
      const abierta = pila.pop();
      if (!abierta) throw new Error(`HTML mal formado: </${tag}> sin etiqueta abierta.`);
      if (abierta.tagName !== tag.toUpperCase()) {
        throw new Error(`HTML mal formado: </${tag}> cierra un <${abierta.tagName.toLowerCase()}>.`);
      }
      i = fin + 1;
      continue;
    }
    if (html[i] === "<" && NOMBRE_ETIQUETA.test(html.slice(i + 1))) {
      const leida = leerEtiquetaApertura(html, i + 1);
      const node = document.createElement(leida.tag);
      aplicarAtributos(node, leida.attrs, document);
      insertar(node);
      i = leida.fin;

      if (ELEMENTOS_VACIOS.has(leida.tag) || leida.autocerrada) continue;

      if (ELEMENTOS_TEXTO_CRUDO.has(leida.tag)) {
        const cierre = html.toLowerCase().indexOf(`</${leida.tag}`, i);
        if (cierre === -1) throw new Error(`HTML mal formado: <${leida.tag}> sin cierre.`);
        const crudo = html.slice(i, cierre);
        if (crudo.length > 0) node.appendChild(document.createTextNode(crudo));
        const finCierre = html.indexOf(">", cierre);
        if (finCierre === -1) throw new Error(`HTML mal formado: </${leida.tag}> sin \`>\`.`);
        i = finCierre + 1;
        continue;
      }

      pila.push(node);
      continue;
    }

    const siguiente = html.indexOf("<", i);
    const hasta = siguiente === -1 ? html.length : siguiente;
    const texto = html.slice(i, hasta);
    if (texto.length > 0 && cima() !== null) {
      cima()?.appendChild(document.createTextNode(decodificarEntidades(texto)));
    }
    i = hasta;
    // Un `<` suelto que no abre etiqueta ni comentario detendría el bucle: se
    // consume como texto para no colgar el analizador.
    if (siguiente !== -1 && hasta === i && texto.length === 0) {
      cima()?.appendChild(document.createTextNode("<"));
      i += 1;
    }
  }

  if (pila.length > 0) {
    const sinCerrar = pila.map((n) => `<${n.tagName.toLowerCase()}>`).join(", ");
    throw new Error(`HTML mal formado: quedan etiquetas sin cerrar: ${sinCerrar}.`);
  }
  if (raiz === null) throw new Error("HTML vacío: no se ha analizado ningún elemento.");

  const documentElement: FakeElement = raiz;
  document.documentElement = documentElement;
  document.head = documentElement.querySelector("head");
  const body = documentElement.querySelector("body");
  if (!body) throw new Error("El HTML analizado no tiene <body>.");
  document.body = body;
  document.readyState = opciones.readyState ?? "interactive";
  return document;
}
