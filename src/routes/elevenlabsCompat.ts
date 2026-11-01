import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

import { elevenlabsCompatAvailabilitySchema } from "../schemas/elevenlabsCompatSchemas.js";
import type { ElevenLabsCompatService } from "../services/elevenlabsCompatService.js";
import { setResultCategory } from "../plugins/observability.js";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * LA RUTA DE COMPATIBILIDAD `/v1/elevenlabs/availability`.
 *
 * Su única razón de existir es que la migración del agente de voz sea el
 * cambio de UNA URL —de la del túnel a la del dominio— sin tocar ni la
 * cabecera, ni el cuerpo, ni la forma de la respuesta, ni las frases. Un
 * cambio de un solo campo es un cambio que se revierte en segundos si algo
 * va mal; un cambio de contrato en el mismo movimiento no lo es.
 *
 * TRES PROPIEDADES QUE NO SE NEGOCIAN:
 *
 * 1. **Sólo lectura.** Aquí se registra `availability` y NADA más. Las otras
 *    dos herramientas del puente (`book`, `human-help`) no tienen ruta de
 *    compatibilidad: `book` escribe, y la creación de citas sigue
 *    desarmada por decisión explícita. Que no exista la ruta es una
 *    garantía más fuerte que que exista y se niegue.
 *
 * 2. **Apagable sin desplegar.** Toda la ruta cuelga de
 *    `ENABLE_ELEVENLABS_COMPAT`. El rollback de esta función es poner esa
 *    variable a `false` y reiniciar el contenedor, sin reconstruir imagen y
 *    sin tocar el código.
 *
 * 3. **El secreto se compara en tiempo constante**, igual que el guardián de
 *    `/ai/*`, y no se registra en ninguna línea de log.
 * ─────────────────────────────────────────────────────────────────────────
 */

const HEADER = "x-booking-voice-secret";

/** Comparación en tiempo constante, segura con longitudes distintas. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export interface ElevenLabsCompatRoutesOptions {
  compat: ElevenLabsCompatService;
  /**
   * El secreto que ElevenLabs envía en `X-Booking-Voice-Secret`. Es una
   * variable propia y no `AI_WEBHOOK_SECRET` reutilizado a la fuerza porque
   * el valor que el agente tiene configurado hoy vive en el dashboard de
   * ElevenLabs, no en este repositorio: separarlos permite migrar sin rotar
   * y rotar sin migrar, en dos pasos reversibles por separado.
   */
  secret: string;
}

export async function registerElevenLabsCompatRoutes(
  app: FastifyInstance,
  opts: ElevenLabsCompatRoutesOptions,
): Promise<void> {
  const { compat, secret } = opts;

  await app.register(async (scoped) => {
    scoped.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
      const provided = request.headers[HEADER];
      const value = Array.isArray(provided) ? provided[0] : provided;
      if (!value || !safeEqual(value, secret)) {
        request.log.warn(
          { route: "/v1/elevenlabs/availability" },
          "rejected elevenlabs compat request: bad or missing tool secret",
        );
        setResultCategory(request, "unauthorized");
        // La misma forma de error que el puente devuelve hoy, para que un
        // fallo de autenticación tras la migración se lea igual que antes.
        await reply.code(401).send({ error: "unauthorized_tool_request", external_mutation: false });
      }
    });

    scoped.post("/v1/elevenlabs/availability", async (request, reply) => {
      const parsed = elevenlabsCompatAvailabilitySchema.safeParse(request.body);
      if (!parsed.success) {
        setResultCategory(request, "invalid_request");
        return reply.code(400).send({
          error: "invalid_tool_request",
          external_mutation: false,
          issues: (parsed.error as z.ZodError).issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }

      if (compat.outsideWindow(parsed.data.date_iso)) {
        setResultCategory(request, "invalid_request");
        return reply.code(422).send({
          error: "date_outside_supported_window",
          // El «hoy» del reloj de Madrid, no el del servidor: un VPS en UTC
          // anunciaría la ventana equivocada una o dos horas cada día.
          message: `Este puente sólo consulta entre ${compat.today()} y ${compat.windowEnd()}.`,
          external_mutation: false,
        });
      }

      const body = await compat.availability(parsed.data);
      // Un 200 que dice «fallo técnico» es una degradación, no un éxito sin
      // huecos: si las dos se registraran igual, una caída del upstream sería
      // indistinguible de una agenda llena en la única línea que un operador
      // mira.
      setResultCategory(
        request,
        body.reason_code === "TECHNICAL_FAILURE"
          ? "upstream_error"
          : body.ok === true
            ? "ok"
            : "no_slots",
      );
      return reply.code(200).send(body);
    });
  });
}
