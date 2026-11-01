import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

import { buildBookingWebServer } from "../../src/bookingWeb/server.js";
import { createBookingStore } from "../../src/bookingWeb/store.js";
import { buildTenantRegistry } from "../../src/bookingWeb/tenants.js";

/**
 * Ayudas compartidas por la suite de la demostración web de reservas.
 *
 * Cada prueba construye su PROPIO servidor con su PROPIO almacén y su PROPIO
 * registro de locales: no hay estado compartido entre ficheros de prueba, así
 * que el orden en que vitest los ejecute no puede cambiar ningún resultado.
 */

export type Json = Record<string, unknown>;

export function freshApp(): FastifyInstance {
  return buildBookingWebServer({ store: createBookingStore(), registry: buildTenantRegistry() });
}

export async function getJson(app: FastifyInstance, url: string): Promise<Json> {
  const res = await app.inject({ method: "GET", url });
  return res.json() as Json;
}

/** Las etiquetas «HH:mm» de la lista de inicios, que es como se comparan en las pruebas. */
export function labelsOf(starts: unknown): string[] {
  return (starts as { label: string }[]).map((s) => s.label);
}

export async function availability(
  app: FastifyInstance,
  tenantId: string,
  serviceId: number,
  date: string,
  employeeId?: number,
): Promise<Json> {
  const query =
    employeeId === undefined
      ? `serviceId=${String(serviceId)}&date=${date}`
      : `serviceId=${String(serviceId)}&date=${date}&employeeId=${String(employeeId)}`;
  const res = await app.inject({ method: "GET", url: `/api/${tenantId}/availability?${query}` });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
  return res.json() as Json;
}

/** Los inicios de UNA persona, en etiquetas «HH:mm». */
export async function startsFor(
  app: FastifyInstance,
  tenantId: string,
  serviceId: number,
  date: string,
  employeeId: number,
): Promise<string[]> {
  const body = await availability(app, tenantId, serviceId, date, employeeId);
  return labelsOf(body.starts);
}

export interface BookInput {
  serviceId: number;
  employeeId: number;
  date: string;
  startMinutes: number;
  payment_option: "pay_now_demo" | "pay_at_salon";
  idempotencyKey: string;
}

export async function book(
  app: FastifyInstance,
  tenantId: string,
  input: BookInput,
): Promise<{ statusCode: number; body: Json }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/${tenantId}/book`,
    payload: input as never,
  });
  return { statusCode: res.statusCode, body: res.json() as Json };
}

export async function dashboard(app: FastifyInstance, tenantId: string): Promise<Json> {
  return getJson(app, `/api/${tenantId}/dashboard`);
}

export async function reset(app: FastifyInstance, tenantId: string): Promise<Json> {
  const res = await app.inject({ method: "POST", url: `/api/${tenantId}/reset` });
  expect(res.statusCode).toBe(200);
  return res.json() as Json;
}
