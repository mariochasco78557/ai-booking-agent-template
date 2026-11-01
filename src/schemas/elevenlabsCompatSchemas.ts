import { z } from "zod";

import { isValidDateISO } from "../callEngine/domain/time.js";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * EL CONTRATO DE ENTRADA DE ElevenLabs, REPLICADO CARÁCTER A CARÁCTER.
 *
 * Estos schemas son una copia deliberada de `SLOT_REQUEST_FIELDS` en
 * `src/voice/elevenlabs/server.ts`. Copiar en vez de importar es una
 * decisión, no un descuido: el puente es un proceso que hoy está EN EL AIRE
 * atendiendo al agente de voz por el túnel, y refactorizarlo para exportar
 * sus constantes cambiaría el fichero del que depende esa llamada viva. El
 * coste de la copia —que las dos definiciones se separen con el tiempo— se
 * paga con una prueba de equivalencia (`tests/elevenlabsCompat.test.ts`)
 * que lanza el MISMO cuerpo contra el puente real y contra esta ruta y
 * exige el mismo veredicto. Una copia vigilada por una prueba es más segura
 * que un refactor de un proceso en producción.
 *
 * Cuando ElevenLabs esté migrado y el puente se apague, esta copia pasa a
 * ser la única definición y deja de ser una copia.
 * ─────────────────────────────────────────────────────────────────────────
 */

const CONVERSATION_ID_SCHEMA = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, "conversation_id contiene caracteres no permitidos");

const DATE_SCHEMA = z
  .string()
  .refine(isValidDateISO, "date_iso debe ser una fecha real con formato YYYY-MM-DD");

const TIME_SCHEMA = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "time debe tener formato HH:mm")
  .refine((value) => {
    const [hours, minutes] = value.split(":").map(Number);
    return (
      hours !== undefined && minutes !== undefined && hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
    );
  }, "time debe representar una hora real");

const PROFESSIONAL_NUMBER_SCHEMA = z.number().int().positive().max(1_000_000);

/**
 * La misma coerción estrecha que el puente: dígitos y nada más. ElevenLabs
 * sólo admite un literal en `type`, así que un profesional concreto llega
 * como `"3"` y el literal `"any"` tiene que seguir cabiendo en el mismo
 * campo. `""`, `"abc"`, `"3.5"`, `" 3"` y `"-1"` siguen siendo 400.
 */
const PROFESSIONAL_SCHEMA = z.union([
  PROFESSIONAL_NUMBER_SCHEMA,
  z.literal("any"),
  z
    .string()
    .regex(/^\d+$/, 'professional_id debe ser un número, un número en texto como "3", o el literal "any"')
    .transform((value) => Number.parseInt(value, 10))
    .pipe(PROFESSIONAL_NUMBER_SCHEMA),
]);

const SERVICE_SCHEMA = z.union([z.literal(0), z.literal(1), z.literal(2)]);

export const elevenlabsCompatAvailabilitySchema = z
  .object({
    conversation_id: CONVERSATION_ID_SCHEMA,
    date_iso: DATE_SCHEMA,
    time: TIME_SCHEMA,
    service_id: SERVICE_SCHEMA,
    professional_id: PROFESSIONAL_SCHEMA,
    /**
     * Sigue siendo obligatoriamente `true` y sigue sin usarse para decidir
     * nada: es la marca de que el agente confirmó el servicio con la
     * persona ANTES de consultar. Aceptar `false` aquí convertiría una
     * salvaguarda del contrato hablado en un campo decorativo.
     */
    service_confirmed: z.literal(true),
  })
  .strict();

export type ElevenLabsCompatAvailabilityInput = z.infer<typeof elevenlabsCompatAvailabilitySchema>;
