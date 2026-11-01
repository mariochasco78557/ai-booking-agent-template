# Métricas de un futuro piloto

> **Ninguna cifra de este documento está medida.** Es el diseño de qué se
> medirá cuando exista un piloto real. Los umbrales son **propuestas**, no
> acuerdos: ninguno está aprobado por Bruno. Y una demo local con datos
> sintéticos **no establece línea base** de nada.

## Eventos mínimos

`CALL_STARTED`, `INTENT_CLASSIFIED`, `STATE_TRANSITION`, `OUTCOME_EMITTED`, `CALLBACK_REQUESTED`, `STAFF_INTERRUPTION_RECORDED`, `TECHNICAL_FAILURE` y `CALL_ENDED`. El contrato está en `pilot-event.schema.json`. Se usa `callIdHash` con SHA-256 y sal del piloto; no se guardan teléfono, nombre, transcripción, audio ni referencia de reserva en este evento.

## Fórmulas

Sea `N` el número de llamadas con exactamente un `OUTCOME_EMITTED`:

- tasa de resolución = llamadas `RESUELVE` / `N`;
- tasa de derivación = llamadas `DERIVA` / `N`;
- tasa de rechazo = llamadas `RECHAZA` / `N`;
- tasa de fallo técnico = llamadas con `TECHNICAL_FAILURE` / llamadas con `CALL_STARTED`;
- cierre completo = llamadas con `CALL_ENDED` / llamadas con `CALL_STARTED`;
- **latencia p95 de resultado — NO SE RECOGE. Ver "Latencia" más abajo.** No es calculable sobre la salida de este motor y no debe reportarse;
- integridad = llamadas con un único resultado y reason code válido / `N`;
- falsa confirmación = resultados `TECHNICAL_FAILURE` con `announcesSuccess=true` / resultados `TECHNICAL_FAILURE`. Todo `OUTCOME_EMITTED` registra el booleano `announcesSuccess`;
- interrupciones por llamada = eventos `STAFF_INTERRUPTION_RECORDED` / llamadas con `CALL_STARTED`;
- contención elegible = llamadas `RESUELVE` / llamadas entrantes cuyo intento estaba dentro del alcance;
- reducción relativa de interrupciones = (interrupciones por llamada en baseline − interrupciones por llamada en piloto) / interrupciones por llamada en baseline.

Las tasas se reportan con numerador y denominador, no solo porcentaje.

### De qué campo se calculan: la dimensión interna, no el `reasonCode` congelado

El enum de diez `reasonCode` de `pilot-event.schema.json` está congelado en su
forma v1 y **no basta** para calcular estas fórmulas correctamente: un caso
real —el cliente entendido que nunca da la confirmación final de la reserva—
no tiene código propio entre los diez y viaja como `INTENT_NOT_UNDERSTOOD`.

Por eso existe una dimensión de resultado **interna** y versionable
(`src/callEngine/outcomeDimension.ts`), que **no** modifica el contrato
congelado. Quien calcule métricas debe leer:

- el evento interno `INTERNAL_OUTCOME_RESOLVED` (uno por llamada), o
- `ConversationResult.internalReasonCode`,

y usar las tres respuestas ya resueltas que ambos llevan:
`countsAsNotUnderstood`, `countsAsBookingConversion` y `countsAsContained`.
Calcular sobre el `reasonCode` congelado da cifras contaminadas. El detalle y
el mapa de compatibilidad externa v1 están en
(internal doc, not included in the template).

Sobre `BOOKING_NOT_CONFIRMED` en concreto: **no** cuenta como no-comprensión
(la intención sí se entendió), **no** cuenta como conversión de reserva y
**no** cuenta como contención. Esa última decisión está razonada en
(internal doc, not included in the template); se tomó en contra de la lectura que habría favorecido a la
métrica.

## Latencia: no se recoge en esta demo

Este motor **no emite `latencyMs`**, y eso es deliberado.

`pilot-event.schema.json` declara `latencyMs` como campo **opcional** (no
aparece en su `required`). Hasta step 13 el emisor lo rellenaba con `counter *
5`: un múltiplo del contador interno de eventos, no una medición de nada.
Aplicar a esa salida la fórmula "percentil 95 de `latencyMs` en
`OUTCOME_EMITTED`" habría producido un número con apariencia de latencia real
sin serlo. Se dejó de emitir por completo (`src/callEngine/events/emitter.ts`).

No se sustituyó por el tiempo de ejecución de `runConversation`, y tampoco
debe hacerse: ese motor es síncrono, determinista y enteramente en memoria,
sin transporte, sin audio y sin red (ver `tests/callEngine/boundaries.test.ts`).
Su tiempo de ejecución no se parece a lo que percibe una persona al teléfono, y
presentarlo como si lo fuera sería exactamente el mismo engaño que el contador
sintético.

**Estado: NO RECOGIDO.** No hay latencia p95 que reportar. Cualquier cuadro de
mando construido sobre esta demo debe mostrar este indicador como *no
disponible*, nunca como cero, nunca como un valor por defecto y nunca omitido
en silencio.

### Dónde se medirá cuando exista un transporte real

La latencia relevante es la **percibida por quien llama**, y se mide en el
transporte, no en este módulo. Frontera de medición propuesta:

- **Inicio (t0):** el instante en que la pasarela de telefonía marca fin de
  habla del cliente (resultado final del STT), no el inicio de su frase.
- **Fin (t1):** el instante en que se emite hacia el cliente el **primer byte
  de audio** de la respuesta del agente, no el momento en que el motor decide.
- **`latencyMs` = t1 − t0**, en enteros de milisegundo, medido con el reloj de
  la pasarela.

Así medido, `latencyMs` incluye lo que de verdad sufre quien llama: STT + este
motor + TTS + red. Medir solo el motor daría un número bonito e inútil.

Cuando ese transporte exista, el campo `latencyMs` ya está previsto en el
esquema v1 y puede volver a poblarse **sin cambiar el contrato**: es opcional,
así que los eventos actuales (que lo omiten) y los futuros (que lo llevarán)
validan ambos contra el mismo esquema congelado. Hasta entonces, el campo
existe y nadie lo rellena.

## Hipótesis a validar

Ninguno de estos umbrales está acordado. La columna es una **propuesta** que
requiere la aprobación explícita de Bruno, y varias de ellas requieren además
medir antes de fijar cifra.

| Hipótesis | Señal | Umbral PROPUESTO, pendiente de aprobación |
| --- | --- | --- |
| El alcance se entiende | `countsAsNotUnderstood` (no el `reasonCode` congelado; excluye `BOOKING_NOT_CONFIRMED`) | < 10% en muestra supervisada. Propuesto. |
| El sistema falla de forma honesta | falsas confirmaciones | 0. Ver nota abajo: esto no es una propuesta negociable. |
| Cancelar/cambiar no causa efectos | mutaciones en esos intentos | 0. Ver nota abajo: esto no es una propuesta negociable. |
| La respuesta es utilizable | latencia p95 | **Sin umbral.** No se recoge todavía; no se propone cifra sobre algo que nadie ha medido. |
| La automatización aporta valor | `countsAsContained` | > 50%, sin contar rechazos como éxito. Propuesto. |
| Se protege el ritmo de trabajo | `STAFF_INTERRUPTION_RECORDED` | Menor que la línea base medida. Sin cifra hasta medir esa línea base. |

**Las dos filas marcadas "no negociable" son invariantes de ingeniería, no
umbrales de negocio.** Que una falsa confirmación sea 0 y que cancelar o
cambiar no mute nada no son objetivos que se acuerden con el cliente: los
impone el código y los fija la suite de pruebas. Aparecen en esta tabla porque
también se miden, no porque estén pendientes de aprobación.

No se fija un objetivo comercial definitivo hasta tener volumen, consentimiento y muestra representativa.
