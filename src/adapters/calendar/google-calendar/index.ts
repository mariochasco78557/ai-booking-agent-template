/**
 * Adaptador `google-calendar` del puerto `CalendarProvider` (fase 3, D-014).
 *
 * Calendario por defecto para negocios sin sistema de reservas propio. Una
 * cuenta de servicio de Google (credencial fuera de git) con acceso de
 * escritura a los calendarios que el negocio le comparte.
 *
 * Correspondencia (ver README.md de esta carpeta):
 * - recurso = empleado de `cliente.yaml` (id numérico `empleados[].id` o
 *   posición), con su calendario (`empleados[].calendario`) o el calendario
 *   único del negocio (`calendario.google.calendario_unico`);
 * - servicio = `servicios[]` de `cliente.yaml` (duración);
 * - cita = evento con resumen `<servicio> - <cliente>`, descripción con
 *   teléfono y servicio, y propiedades privadas `flowara.*`; id del evento
 *   derivado del id numérico de la cita (`fb` + 15 dígitos);
 * - huecos = horario de `cliente.yaml` menos ocupado (free/busy, o eventos del
 *   calendario único), troceado cada `paso_min`, en la zona de `cliente.yaml`;
 * - anular = borrar el evento (Google lo deja en estado `cancelled`).
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import type {
  AiAvailabilityData,
  AiAvailabilityRequest,
  AiAvailabilitySlotData,
  AiAvailabilitySlotRequest,
  AiCancellationData,
  AiCancellationProofData,
  AiCancellationProofRequest,
  AiCancellationRequest,
  AiEnvelope,
  AiLookupData,
  AiLookupMatch,
  AiLookupRequest,
  AiReservationData,
  AiReservationRequest,
} from "../../../clients/aiTypes.js";
import { UpstreamError } from "../../../core/calendar/errors.js";
import type {
  BackOfficeBooking,
  BackOfficeBookingList,
  BackOfficeRange,
  CalendarBackOffice,
  CalendarBookingRequest,
  CalendarProvider,
  CalendarResource,
  CreatedBooking,
  FreeSlotsQuery,
  ResourceFreeSlots,
} from "../../../core/calendar/CalendarProvider.js";
import type { ClientConfig } from "../../../core/config/clientConfig.js";
import type { Logger } from "../../../services/authTokenService.js";
import { normalizeSpanishPhone } from "../../../utils/phone.js";
import {
  GoogleApi,
  loadServiceAccount,
  type FetchLike,
  type GoogleEvent,
  type GoogleEventList,
  type GoogleEventTime,
  type GoogleFreeBusyResponse,
  type ServiceAccountCredentials,
} from "./googleApi.js";
import { googleSettingsFromClientConfig, type GoogleCalendarSettings, type GoogleEmployee, type GoogleService } from "./settings.js";
import {
  addDays,
  hhmm,
  isIsoDate,
  localDateTime,
  parseWall,
  wallToEpochMs,
  wallToMinutes,
  weekdayOf,
} from "./timezone.js";

/** Claves de `extendedProperties.private` (búsquedas con `privateExtendedProperty`). */
export const PROP = {
  bookingId: "flowara.bookingId",
  phone: "flowara.phone",
  serviceId: "flowara.serviceId",
  employeeId: "flowara.employeeId",
  ownerName: "flowara.ownerName",
  ownerSurnames: "flowara.ownerSurnames",
} as const;

/** Mensaje de hueco ocupado: lo reconoce `looksLikeSlotTaken` del núcleo. */
export const SLOT_TAKEN_UPSTREAM_MESSAGE = "La fecha y hora solicitadas ya no están disponibles.";

const PROOF_TTL_SECONDS = 120;
const PROOF_MAX_ATTEMPTS = 3;
const PROOF_ATTEMPT_WINDOW_MS = 60 * 60_000;
const LOOKUP_MAX_MATCHES = 3;
const DEFAULT_MAX_SLOTS = 6;
const MAX_MAX_SLOTS = 20;
const MAX_PAGES = 20;

/** Id del evento de Google para una cita: base32hex (`fb` + 15 dígitos). */
export function eventIdForBooking(bookingId: number): string {
  return `fb${String(bookingId).padStart(15, "0")}`;
}

/** Id de cita de un id de evento propio; `null` si el evento no es de Flowara. */
export function bookingIdFromEventId(eventId: string): number | null {
  const m = /^fb(\d{15})$/.exec(eventId);
  return m ? Number(m[1]) : null;
}

/** Teléfono a E.164 sin suponer país: `+…`/`00…` tal cual; si no, normalización española; si no, dígitos. */
export function toE164(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const stripped = raw.trim().replace(/[\s().-]/g, "");
  if (stripped === "") return undefined;
  if (/^\+\d{6,15}$/.test(stripped)) return stripped;
  if (/^00\d{6,15}$/.test(stripped)) return `+${stripped.slice(2)}`;
  const es = normalizeSpanishPhone(stripped);
  return es.ok ? es.e164 : stripped;
}

function normName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function displayName(e: { name: string; surnames: string }): string {
  return `${e.name} ${e.surnames}`.replace(/\s+/g, " ").trim();
}

type Interval = readonly [number, number];

function overlaps(a: Interval, busy: readonly Interval[]): boolean {
  return busy.some(([s, e]) => s < a[1] && e > a[0]);
}

function envelope<T>(code: string, message: string, data: T, ok = true): AiEnvelope<T> {
  return { ok, code, message, data };
}

/** Respuesta no 2xx del contrato asistente: `UpstreamError` con `code` (como el cliente Demo Salon). */
function contractError(status: number, code: string, message: string): UpstreamError {
  return new UpstreamError(`google-calendar ${code}`, { status, code, upstreamMessage: message });
}

export interface GoogleCalendarDeps {
  api: Pick<GoogleApi, "getToken" | "invalidate" | "request">;
  settings: GoogleCalendarSettings;
  logger: Logger;
  now?: () => number;
  /** Id numérico de cita nuevo (por defecto aleatorio de 15 dígitos como máximo). */
  newBookingId?: () => number;
}

interface FoundEvent {
  calendarId: string;
  event: GoogleEvent;
}

interface ProofRecord {
  ref: string;
  expiresAtMs: number;
  usedAtMs?: number;
}

export class GoogleCalendar implements CalendarProvider {
  readonly id = "google-calendar" as const;
  private readonly now: () => number;
  private readonly newBookingId: () => number;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly proofs = new Map<string, ProofRecord>();
  private readonly attempts = new Map<string, { count: number; sinceMs: number }>();

  constructor(private readonly deps: GoogleCalendarDeps) {
    this.now = deps.now ?? Date.now;
    this.newBookingId = deps.newBookingId ?? (() => randomInt(1_000_000_000, 2 ** 47));
  }

  private get s(): GoogleCalendarSettings {
    return this.deps.settings;
  }

  // ── sesión ────────────────────────────────────────────────────────────────

  /** Pide (o reutiliza) el token OAuth de la cuenta de servicio. */
  async ensureSession(): Promise<void> {
    await this.deps.api.getToken();
  }

  /** Descarta el token: la siguiente llamada pide otro. */
  resetSession(): void {
    this.deps.api.invalidate();
  }

  // ── consultas de configuración ────────────────────────────────────────────

  private employee(id: number): GoogleEmployee | undefined {
    return this.s.employees.find((e) => e.id === Number(id));
  }

  private service(id: string | number): GoogleService | undefined {
    return this.s.services.find((sv) => sv.id === String(id));
  }

  private durationOf(serviceId: string | number): number {
    return this.service(serviceId)?.durationMin ?? this.s.defaultDurationMin;
  }

  private calendarOf(e: GoogleEmployee): string {
    return this.s.singleCalendarId ?? e.calendarId;
  }

  private allCalendars(): string[] {
    return [...new Set(this.s.employees.map((e) => this.calendarOf(e)))];
  }

  private isHoliday(date: string): boolean {
    return this.s.closures.some((c) => c.from <= date && date <= c.to);
  }

  /** Franjas de apertura de `date` (vacío si cierra). */
  private franjas(date: string): Array<[number, number]> {
    if (this.isHoliday(date)) return [];
    const wd = weekdayOf(date);
    if (this.s.closedWeekdays.has(wd)) return [];
    return this.s.openingHours[wd] ?? [];
  }

  private toResource(e: GoogleEmployee): CalendarResource {
    return { id: e.id, name: e.name, surnames: e.surnames };
  }

  // ── ocupado ───────────────────────────────────────────────────────────────

  private eventInstant(t: GoogleEventTime | undefined): number | null {
    if (t === undefined) return null;
    if (t.dateTime !== undefined) {
      if (/(Z|[+-]\d{2}:?\d{2})$/i.test(t.dateTime)) return Date.parse(t.dateTime);
      const w = parseWall(t.dateTime);
      return w === null ? null : wallToEpochMs(w.date, w.minutes, t.timeZone ?? this.s.timeZone);
    }
    if (t.date !== undefined && isIsoDate(t.date)) return wallToEpochMs(t.date, 0, this.s.timeZone);
    return null;
  }

  private eventInterval(ev: GoogleEvent): Interval | null {
    const a = this.eventInstant(ev.start);
    const b = this.eventInstant(ev.end);
    return a === null || b === null || Number.isNaN(a) || Number.isNaN(b) ? null : [a, b];
  }

  private async listEvents(calendarId: string, query: Record<string, string | number | boolean>): Promise<GoogleEvent[]> {
    const out: GoogleEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await this.deps.api.request<GoogleEventList>(
        "GET",
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        { query: { singleEvents: true, maxResults: 2500, ...query, ...(pageToken ? { pageToken } : {}) } },
      );
      out.push(...(res?.items ?? []));
      pageToken = res?.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /**
   * Intervalos ocupados por empleado entre dos instantes. Por calendario de
   * empleado: `freeBusy` (un calendario inaccesible deja al empleado en
   * `unavailable`). Calendario único: sus eventos; uno con
   * `flowara.employeeId` ocupa a ese empleado, uno sin él (p. ej. creado a mano)
   * ocupa a todos.
   */
  private async busyByEmployee(
    employees: readonly GoogleEmployee[],
    fromMs: number,
    toMs: number,
    excludeEventId?: string,
  ): Promise<{ busy: Map<number, Interval[]>; unavailable: Set<number> }> {
    const busy = new Map<number, Interval[]>(employees.map((e) => [e.id, []]));
    const unavailable = new Set<number>();
    if (employees.length === 0) return { busy, unavailable };
    const timeMin = new Date(fromMs).toISOString();
    const timeMax = new Date(toMs).toISOString();

    if (this.s.singleCalendarId !== undefined || excludeEventId !== undefined) {
      const byCalendar = new Map<string, GoogleEmployee[]>();
      for (const e of employees) byCalendar.set(this.calendarOf(e), [...(byCalendar.get(this.calendarOf(e)) ?? []), e]);
      for (const [calendarId, emps] of byCalendar) {
        const events = await this.listEvents(calendarId, { timeMin, timeMax });
        for (const ev of events) {
          if (ev.status === "cancelled" || ev.transparency === "transparent" || ev.id === excludeEventId) continue;
          const iv = this.eventInterval(ev);
          if (iv === null) continue;
          const tag = ev.extendedProperties?.private?.[PROP.employeeId];
          const single = this.s.singleCalendarId !== undefined;
          for (const e of emps) {
            if (!single || tag === undefined || Number(tag) === e.id) busy.get(e.id)!.push(iv);
          }
        }
      }
      return { busy, unavailable };
    }

    const items = [...new Set(employees.map((e) => e.calendarId))].map((id) => ({ id }));
    const res = await this.deps.api.request<GoogleFreeBusyResponse>("POST", "/freeBusy", {
      body: { timeMin, timeMax, timeZone: this.s.timeZone, items },
    });
    for (const e of employees) {
      const cal = res?.calendars?.[e.calendarId];
      if (cal === undefined || (cal.errors?.length ?? 0) > 0) {
        unavailable.add(e.id);
        this.deps.logger.warn(
          { employeeId: e.id, reason: cal?.errors?.[0]?.reason ?? "missing" },
          "google-calendar: calendario de empleado no accesible (¿compartido con la cuenta de servicio?)",
        );
        continue;
      }
      for (const b of cal.busy ?? []) {
        const iv: Interval = [Date.parse(b.start), Date.parse(b.end)];
        if (!Number.isNaN(iv[0]) && !Number.isNaN(iv[1])) busy.get(e.id)!.push(iv);
      }
    }
    return { busy, unavailable };
  }

  private dayRange(date: string): [number, number] {
    return [wallToEpochMs(date, 0, this.s.timeZone), wallToEpochMs(addDays(date, 1), 0, this.s.timeZone)];
  }

  /** ¿Cabe una cita de `durationMin` que empieza a `startMin` de `date`? */
  private fits(date: string, startMin: number, durationMin: number, busy: readonly Interval[]): boolean {
    const early = this.s.earlyClose[weekdayOf(date)];
    if (early !== undefined && startMin >= early) return false;
    const inside = this.franjas(date).some(([a, b]) => startMin >= a && startMin + durationMin <= b);
    if (!inside) return false;
    const start = wallToEpochMs(date, startMin, this.s.timeZone);
    if (start <= this.now()) return false;
    const end = wallToEpochMs(date, startMin + durationMin, this.s.timeZone);
    return !overlaps([start, end], busy);
  }

  private freeStarts(date: string, durationMin: number, busy: readonly Interval[]): number[] {
    const out: number[] = [];
    for (const [a, b] of this.franjas(date)) {
      for (let t = a; t + durationMin <= b; t += this.s.stepMin) {
        if (this.fits(date, t, durationMin, busy)) out.push(t);
      }
    }
    return out;
  }

  // ── puerto: lectura ───────────────────────────────────────────────────────

  /**
   * Empleados que trabajan `date`: el negocio abre ese día, su calendario es
   * accesible y no está ocupado durante todo el horario (p. ej. un evento de
   * día completo «Vacaciones»).
   */
  async listResourcesForDay(date: string): Promise<CalendarResource[]> {
    const franjas = isIsoDate(date) ? this.franjas(date) : [];
    if (franjas.length === 0) return [];
    const [from, to] = this.dayRange(date);
    const { busy, unavailable } = await this.busyByEmployee(this.s.employees, from, to);
    return this.s.employees
      .filter((e) => !unavailable.has(e.id))
      .filter((e) => {
        const b = busy.get(e.id) ?? [];
        return franjas.some(([a, z]) => {
          const iv: Interval = [wallToEpochMs(date, a, this.s.timeZone), wallToEpochMs(date, z, this.s.timeZone)];
          // Ocupado toda la franja = algún intervalo la cubre entera.
          return !b.some(([s, e2]) => s <= iv[0] && e2 >= iv[1]);
        });
      })
      .map((e) => this.toResource(e));
  }

  async listFreeSlots(query: FreeSlotsQuery): Promise<ResourceFreeSlots[]> {
    if (query.resourceIds.length === 0) return [];
    if (!isIsoDate(query.date) || this.franjas(query.date).length === 0) return [];
    const employees = query.resourceIds
      .map((id) => this.employee(id))
      .filter((e): e is GoogleEmployee => e !== undefined);
    if (employees.length === 0) return [];
    const duration = this.durationOf(query.serviceId);
    const [from, to] = this.dayRange(query.date);
    const { busy, unavailable } = await this.busyByEmployee(employees, from, to);
    const out: ResourceFreeSlots[] = [];
    for (const e of employees) {
      if (unavailable.has(e.id)) continue;
      const starts = this.freeStarts(query.date, duration, busy.get(e.id) ?? []);
      if (starts.length === 0) continue;
      out.push({
        ...this.toResource(e),
        date: query.date,
        slots: starts.map((t) => ({
          start: `${query.date} ${hhmm(t)}:00`,
          end: `${query.date} ${hhmm(t + duration)}:00`,
        })),
      });
    }
    return out;
  }

  // ── puerto: escritura ─────────────────────────────────────────────────────

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  /**
   * Comprueba el hueco e inserta el evento, en serie por calendario dentro de
   * este proceso. Hueco ocupado/fuera de horario -> `UpstreamError` 409 con
   * el mensaje que el núcleo reconoce como «ya no disponible».
   */
  private async insertBooking(input: {
    date: string;
    startMin: number;
    employee: GoogleEmployee;
    service: GoogleService;
    ownerName: string;
    ownerSurnames: string;
    phone?: string;
    beforeInsert?: () => Promise<void>;
  }): Promise<{ bookingId: number; eventId: string }> {
    const { employee: emp, service } = input;
    return this.withLock(this.calendarOf(emp), async () => {
      await input.beforeInsert?.();
      const [from, to] = this.dayRange(input.date);
      const { busy, unavailable } = await this.busyByEmployee([emp], from, to);
      if (unavailable.has(emp.id)) {
        throw new UpstreamError("google-calendar calendar not accessible", {
          status: 403,
          upstreamMessage: "Calendario del empleado no accesible para la cuenta de servicio",
        });
      }
      if (!this.fits(input.date, input.startMin, service.durationMin, busy.get(emp.id) ?? [])) {
        throw new UpstreamError("google-calendar slot taken", {
          status: 409,
          code: "SLOT_TAKEN",
          upstreamMessage: SLOT_TAKEN_UPSTREAM_MESSAGE,
        });
      }
      const bookingId = this.newBookingId();
      const eventId = eventIdForBooking(bookingId);
      const customer = `${input.ownerName} ${input.ownerSurnames}`.replace(/\s+/g, " ").trim();
      const props: Record<string, string> = {
        [PROP.bookingId]: String(bookingId),
        [PROP.serviceId]: service.id,
        [PROP.employeeId]: String(emp.id),
        [PROP.ownerName]: input.ownerName,
        [PROP.ownerSurnames]: input.ownerSurnames,
        ...(input.phone !== undefined ? { [PROP.phone]: input.phone } : {}),
      };
      await this.deps.api.request<GoogleEvent>("POST", `/calendars/${encodeURIComponent(this.calendarOf(emp))}/events`, {
        body: {
          id: eventId,
          summary: `${service.name} - ${customer}`,
          description: [
            `Tel.: ${input.phone ?? "-"}`,
            `Servicio: ${service.name} (id ${service.id})`,
            `Profesional: ${displayName(emp)}`,
            `Ref.: ${bookingId}`,
          ].join("\n"),
          start: { dateTime: localDateTime(input.date, input.startMin), timeZone: this.s.timeZone },
          end: { dateTime: localDateTime(input.date, input.startMin + service.durationMin), timeZone: this.s.timeZone },
          extendedProperties: { private: props },
        },
      });
      return { bookingId, eventId };
    });
  }

  async createBooking(request: CalendarBookingRequest): Promise<CreatedBooking> {
    const wall = parseWall(request.reservationDate);
    const emp = this.employee(request.employee.id);
    const service = this.service(request.typeReservation);
    if (wall === null || emp === undefined || service === undefined) {
      throw new UpstreamError("google-calendar invalid booking request", {
        status: 400,
        upstreamMessage:
          wall === null ? "reservationDate inválida" : emp === undefined ? "empleado desconocido" : "servicio desconocido",
      });
    }
    const { bookingId } = await this.insertBooking({
      date: wall.date,
      startMin: wall.minutes,
      employee: emp,
      service,
      ownerName: request.ownerName,
      ownerSurnames: request.ownerSurnames,
      ...(toE164(request.ownerPhone) !== undefined ? { phone: toE164(request.ownerPhone)! } : {}),
    });
    return { id: bookingId };
  }

  /**
   * Mover una cita (fuera del puerto: el núcleo mueve = anular + crear). Parche
   * de `start`/`end` del mismo evento tras comprobar el nuevo hueco sin contar
   * la propia cita. `"not_found"` si ya no existe.
   */
  async moveBooking(bookingId: number, reservationDate: string): Promise<"moved" | "not_found"> {
    const wall = parseWall(reservationDate);
    if (wall === null) throw new UpstreamError("google-calendar invalid date", { status: 400 });
    const found = await this.findEvent(eventIdForBooking(bookingId));
    if (found === null) return "not_found";
    const props = found.event.extendedProperties?.private ?? {};
    const emp = this.employee(Number(props[PROP.employeeId]));
    if (emp === undefined) throw new UpstreamError("google-calendar unknown employee", { status: 400 });
    const duration = this.durationOf(props[PROP.serviceId] ?? "");
    return this.withLock(this.calendarOf(emp), async () => {
      const [from, to] = this.dayRange(wall.date);
      const { busy } = await this.busyByEmployee([emp], from, to, found.event.id);
      if (!this.fits(wall.date, wall.minutes, duration, busy.get(emp.id) ?? [])) {
        throw new UpstreamError("google-calendar slot taken", {
          status: 409,
          code: "SLOT_TAKEN",
          upstreamMessage: SLOT_TAKEN_UPSTREAM_MESSAGE,
        });
      }
      await this.deps.api.request<GoogleEvent>(
        "PATCH",
        `/calendars/${encodeURIComponent(found.calendarId)}/events/${found.event.id}`,
        {
          body: {
            start: { dateTime: localDateTime(wall.date, wall.minutes), timeZone: this.s.timeZone },
            end: { dateTime: localDateTime(wall.date, wall.minutes + duration), timeZone: this.s.timeZone },
          },
        },
      );
      return "moved" as const;
    });
  }

  // ── búsqueda y borrado por id ─────────────────────────────────────────────

  /** Evento vigente (no cancelado) con ese id en alguno de los calendarios; `null` si no. */
  private async findEvent(eventId: string): Promise<FoundEvent | null> {
    if (bookingIdFromEventId(eventId) === null) return null;
    for (const calendarId of this.allCalendars()) {
      try {
        const event = await this.deps.api.request<GoogleEvent>(
          "GET",
          `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
        );
        if (event !== null && event.status !== "cancelled") return { calendarId, event };
      } catch (err) {
        if (err instanceof UpstreamError && (err.status === 404 || err.status === 410)) continue;
        throw err;
      }
    }
    return null;
  }

  /** Borra la cita `bookingId`. Ya borrada o inexistente -> `"not_found"`. */
  async deleteBookingById(bookingId: number): Promise<"deleted" | "not_found"> {
    const found = await this.findEvent(eventIdForBooking(bookingId));
    if (found === null) return "not_found";
    try {
      await this.deps.api.request<null>(
        "DELETE",
        `/calendars/${encodeURIComponent(found.calendarId)}/events/${found.event.id}`,
      );
      return "deleted";
    } catch (err) {
      if (err instanceof UpstreamError && (err.status === 404 || err.status === 410)) return "not_found";
      throw err;
    }
  }

  private toBackOfficeRow(ev: GoogleEvent): BackOfficeBooking | null {
    const props = ev.extendedProperties?.private ?? {};
    const id = Number(props[PROP.bookingId]);
    const start = this.eventInstant(ev.start);
    if (!Number.isSafeInteger(id) || id <= 0 || start === null || Number.isNaN(start)) return null;
    const wall = wallToMinutes(start, this.s.timeZone);
    const emp = this.employee(Number(props[PROP.employeeId]));
    const type = props[PROP.serviceId];
    return {
      id,
      startsAt: `${wall.date} ${hhmm(wall.minutes)}`,
      ownerPhoneE164: props[PROP.phone] ?? null,
      ownerName: props[PROP.ownerName] ?? "",
      ownerSurnames: props[PROP.ownerSurnames] ?? "",
      employeeId: emp?.id ?? null,
      employeeName: emp ? displayName(emp) : null,
      typeReservation: type !== undefined && /^\d+$/.test(type) ? Number(type) : null,
      state: ev.status === "cancelled" ? "cancelled" : "active",
    };
  }

  /**
   * Citas de Flowara en un rango inclusivo de fechas (zona del negocio). Los
   * eventos sin `flowara.bookingId` (creados a mano) no son citas del sistema
   * y no se listan; uno con datos rotos cuenta en `unparseable`.
   */
  async listBookingsInRange(range: BackOfficeRange): Promise<BackOfficeBookingList> {
    if (!isIsoDate(range.fromDate) || !isIsoDate(range.toDate)) {
      throw new UpstreamError("google-calendar invalid range", { status: 400 });
    }
    const timeMin = new Date(wallToEpochMs(range.fromDate, 0, this.s.timeZone)).toISOString();
    const timeMax = new Date(wallToEpochMs(addDays(range.toDate, 1), 0, this.s.timeZone)).toISOString();
    const rows: BackOfficeBooking[] = [];
    let unparseable = 0;
    const seen = new Set<string>();
    for (const calendarId of this.allCalendars()) {
      for (const ev of await this.listEvents(calendarId, { timeMin, timeMax, orderBy: "startTime" })) {
        if (ev.extendedProperties?.private?.[PROP.bookingId] === undefined || seen.has(ev.id)) continue;
        seen.add(ev.id);
        const row = this.toBackOfficeRow(ev);
        if (row === null) unparseable += 1;
        else rows.push(row);
      }
    }
    rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id - b.id);
    return { rows, stats: { total: rows.length + unparseable, unparseable } };
  }

  /** Citas vigentes y futuras de un teléfono, en orden de fecha. */
  private async futureBookingsForPhone(phone: string, fromMs: number): Promise<FoundEvent[]> {
    const out: FoundEvent[] = [];
    const timeMin = new Date(fromMs).toISOString();
    for (const calendarId of this.allCalendars()) {
      const events = await this.listEvents(calendarId, {
        timeMin,
        orderBy: "startTime",
        privateExtendedProperty: `${PROP.phone}=${phone}`,
      });
      for (const event of events) {
        const start = this.eventInstant(event.start);
        if (event.status === "cancelled" || start === null || start < fromMs) continue;
        if (event.extendedProperties?.private?.[PROP.phone] !== phone) continue;
        if (!out.some((f) => f.event.id === event.id)) out.push({ calendarId, event });
      }
    }
    return out.sort((a, b) => (this.eventInstant(a.event.start) ?? 0) - (this.eventInstant(b.event.start) ?? 0));
  }

  private matchOf(found: FoundEvent): AiLookupMatch {
    const props = found.event.extendedProperties?.private ?? {};
    const start = this.eventInstant(found.event.start) ?? 0;
    const wall = wallToMinutes(start, this.s.timeZone);
    const emp = this.employee(Number(props[PROP.employeeId]));
    return {
      reservationRef: found.event.id,
      dateLabel: `${wall.date} ${hhmm(wall.minutes)}`,
      employeeName: emp ? displayName(emp) : "",
    };
  }

  // ── contrato asistente (BOOKING_UPSTREAM_MODE=ai) ──────────────────────────

  async checkAvailability(request: AiAvailabilityRequest): Promise<AiEnvelope<AiAvailabilityData>> {
    if (!isIsoDate(request.date)) throw contractError(400, "INVALID_DATE", "La fecha debe tener el formato YYYY-MM-DD.");
    if (this.service(request.typeReservation) === undefined) {
      throw contractError(400, "INVALID_TYPE_RESERVATION", "Tipo de reserva no permitido.");
    }
    if (this.isHoliday(request.date)) {
      return envelope("CLOSED_HOLIDAY", "El negocio no está disponible el día seleccionado.", { employees: [] }, false);
    }
    const maxSlots = Math.min(Math.max(1, request.maxSlots ?? DEFAULT_MAX_SLOTS), MAX_MAX_SLOTS);
    const ids =
      request.employeeIds !== undefined
        ? request.employeeIds.filter((id) => this.employee(id) !== undefined)
        : (await this.listResourcesForDay(request.date)).map((r) => r.id);
    const free = await this.listFreeSlots({
      date: request.date,
      resourceIds: ids,
      serviceId: String(request.typeReservation),
    });
    return envelope("OK", "Disponibilidad calculada correctamente.", {
      employees: free.map((r) => ({
        employeeId: r.id,
        name: displayName(r),
        slots: r.slots.slice(0, maxSlots).map((sl) => sl.start.slice(11, 16)),
      })),
    });
  }

  private checkedInput(reservationDate: string, employeeId: number, typeReservation: number) {
    const wall = parseWall(reservationDate);
    if (wall === null) throw contractError(400, "INVALID_DATE", "La fecha debe tener el formato YYYY-MM-DD HH:mm:ss.");
    const emp = this.employee(employeeId);
    if (emp === undefined) throw contractError(400, "INVALID_EMPLOYEE", "Empleado no válido.");
    const service = this.service(typeReservation);
    if (service === undefined) throw contractError(400, "INVALID_TYPE_RESERVATION", "Tipo de reserva no permitido.");
    return { wall, emp, service };
  }

  async checkSlot(request: AiAvailabilitySlotRequest): Promise<AiEnvelope<AiAvailabilitySlotData>> {
    const { wall, emp, service } = this.checkedInput(request.reservationDate, request.employeeId, request.typeReservation);
    let available = false;
    if (this.franjas(wall.date).length > 0) {
      const [from, to] = this.dayRange(wall.date);
      const { busy, unavailable } = await this.busyByEmployee([emp], from, to);
      available = !unavailable.has(emp.id) && this.fits(wall.date, wall.minutes, service.durationMin, busy.get(emp.id) ?? []);
    }
    return envelope("OK", "Comprobación de disponibilidad realizada.", { available });
  }

  /**
   * Reserva comprobada: valida, rechaza un teléfono con otra cita futura
   * (409 DUPLICATE_CALLER_BOOKING), vuelve a comprobar el hueco justo antes de
   * insertar (409 SLOT_TAKEN) y devuelve la referencia (id del evento).
   */
  async createCheckedBooking(request: AiReservationRequest): Promise<AiEnvelope<AiReservationData>> {
    const { wall, emp, service } = this.checkedInput(request.reservationDate, request.employeeId, request.typeReservation);
    const phone = toE164(request.customer.phone);
    if (phone === undefined || !/^\+\d{6,15}$/.test(phone)) {
      throw contractError(400, "INVALID_PHONE", "El teléfono no tiene un formato válido.");
    }
    let created: { eventId: string };
    try {
      created = await this.insertBooking({
        date: wall.date,
        startMin: wall.minutes,
        employee: emp,
        service,
        ownerName: request.customer.name,
        ownerSurnames: request.customer.surnames,
        phone,
        beforeInsert: async () => {
          if ((await this.futureBookingsForPhone(phone, this.now())).length > 0) {
            throw contractError(409, "DUPLICATE_CALLER_BOOKING", "Ya existe una reserva futura para este teléfono.");
          }
        },
      });
    } catch (err) {
      if (err instanceof UpstreamError && err.code === "SLOT_TAKEN") {
        throw contractError(409, "SLOT_TAKEN", SLOT_TAKEN_UPSTREAM_MESSAGE);
      }
      if (err instanceof UpstreamError && err.status === 409 && err.code === undefined) {
        // El id de evento ya existía (colisión improbable): misma respuesta que hueco ocupado.
        throw contractError(409, "SLOT_TAKEN", SLOT_TAKEN_UPSTREAM_MESSAGE);
      }
      throw err;
    }
    return envelope("OK", "Reserva creada correctamente.", {
      reservationRef: created.eventId,
      dateLabel: `${wall.date} ${hhmm(wall.minutes)}`,
      employeeName: displayName(emp),
    });
  }

  /**
   * Citas futuras del teléfono verificado por telefonía. Mismas reglas que el
   * contrato Symfony: identificador obligatorio e igual al teléfono pedido,
   * como mucho 3 candidatas (más -> AMBIGUOUS) y solo ref, fecha y profesional.
   */
  async findBookingsByPhone(request: AiLookupRequest, verifiedCallerId: string): Promise<AiEnvelope<AiLookupData>> {
    if (!verifiedCallerId) {
      throw contractError(400, "MISSING_CALLER_ID", "Falta el identificador de llamada verificado por telefonía.");
    }
    const phone = toE164(request.phone);
    if (phone === undefined || !/^\+\d{6,15}$/.test(phone)) {
      throw contractError(400, "INVALID_PHONE", "El teléfono no tiene un formato válido.");
    }
    if (toE164(verifiedCallerId) !== phone) {
      throw contractError(400, "CALLER_ID_MISMATCH", "El teléfono no coincide con el identificador de llamada.");
    }
    let fromMs = this.now();
    if (request.fromDate !== undefined && isIsoDate(request.fromDate)) {
      fromMs = Math.max(fromMs, wallToEpochMs(request.fromDate, 0, this.s.timeZone));
    }
    const found = await this.futureBookingsForPhone(phone, fromMs);
    if (found.length === 0) {
      return envelope("NO_MATCH", "No se ha encontrado ninguna reserva para ese teléfono.", { matches: [] });
    }
    if (found.length > LOOKUP_MAX_MATCHES) {
      return envelope("AMBIGUOUS", "Hay varias reservas que coinciden. Por favor, aporte más datos.", {}, false);
    }
    return envelope("OK", "Se han encontrado reservas.", { matches: found.map((f) => this.matchOf(f)) });
  }

  private pruneProofs(nowMs: number): void {
    for (const [hash, rec] of this.proofs) if (rec.expiresAtMs <= nowMs) this.proofs.delete(hash);
    for (const [ref, a] of this.attempts) if (nowMs - a.sinceMs > PROOF_ATTEMPT_WINDOW_MS) this.attempts.delete(ref);
  }

  /**
   * Justificante de anulación. Google no tiene este concepto: lo emite el
   * adaptador en memoria con las reglas del contrato Symfony (nombre y
   * teléfono deben coincidir con la cita; 120 s; un solo uso; ligado a una
   * cita; 3 intentos por cita y hora). Se guarda solo su sha256.
   */
  async requestCancellationProof(request: AiCancellationProofRequest): Promise<AiEnvelope<AiCancellationProofData>> {
    const nowMs = this.now();
    this.pruneProofs(nowMs);
    const a = this.attempts.get(request.reservationRef) ?? { count: 0, sinceMs: nowMs };
    if (a.count >= PROOF_MAX_ATTEMPTS) {
      throw contractError(429, "TOO_MANY_ATTEMPTS", "Se ha superado el límite de intentos de confirmación para esta reserva.");
    }
    this.attempts.set(request.reservationRef, { count: a.count + 1, sinceMs: a.sinceMs });

    const found = await this.findEvent(request.reservationRef);
    const props = found?.event.extendedProperties?.private ?? {};
    const phoneOk = found !== null && toE164(request.confirm.phone) === props[PROP.phone];
    const stored = normName(props[PROP.ownerName] ?? "");
    const given = normName(request.confirm.name);
    const nameOk =
      given !== "" && stored !== "" && (given === stored || given.split(" ")[0] === stored.split(" ")[0]);
    if (!phoneOk || !nameOk) {
      throw contractError(403, "CONFIRMATION_MISMATCH", "Los datos indicados no coinciden con la reserva solicitada.");
    }
    const proof = randomBytes(32).toString("base64url");
    this.proofs.set(createHash("sha256").update(proof).digest("hex"), {
      ref: request.reservationRef,
      expiresAtMs: nowMs + PROOF_TTL_SECONDS * 1000,
    });
    return envelope("OK", "Justificante de cancelación emitido.", {
      cancellationProof: proof,
      expiresInSeconds: PROOF_TTL_SECONDS,
    });
  }

  /**
   * Anulación con justificante: borra el evento. Justificante ya usado y cita
   * ya inexistente -> 200 `alreadyCancelled` (reintento tras respuesta perdida).
   */
  async cancelBooking(request: AiCancellationRequest): Promise<AiEnvelope<AiCancellationData>> {
    const nowMs = this.now();
    const hash = createHash("sha256").update(request.cancellationProof).digest("hex");
    const rec = this.proofs.get(hash);
    if (rec === undefined) throw contractError(403, "PROOF_INVALID", "El justificante de cancelación no es válido.");
    if (rec.ref !== request.reservationRef) {
      throw contractError(403, "PROOF_SCOPE_MISMATCH", "El justificante no corresponde a esta reserva.");
    }
    if (rec.expiresAtMs <= nowMs) {
      this.proofs.delete(hash);
      throw contractError(403, "PROOF_EXPIRED", "El justificante de cancelación ha caducado.");
    }
    const bookingId = bookingIdFromEventId(request.reservationRef);
    if (rec.usedAtMs !== undefined) {
      const still = bookingId === null ? null : await this.findEvent(request.reservationRef);
      if (still === null) {
        return envelope("OK", "La reserva ya estaba cancelada.", { cancelled: true, alreadyCancelled: true });
      }
      throw contractError(403, "PROOF_ALREADY_USED", "Este justificante ya se utilizó para cancelar la reserva.");
    }
    rec.usedAtMs = nowMs;
    const outcome = bookingId === null ? "not_found" : await this.deleteBookingById(bookingId);
    return outcome === "deleted"
      ? envelope("OK", "Reserva cancelada correctamente.", { cancelled: true, alreadyCancelled: false })
      : envelope("OK", "La reserva ya estaba cancelada.", { cancelled: true, alreadyCancelled: true });
  }
}

/**
 * Back office (autogestión por WhatsApp) sobre su propia instancia del
 * adaptador, con su propio token: un 401 aquí no toca el de la cuenta de
 * reservas (mismo criterio que Demo Salon, ADR-032).
 */
export class GoogleCalendarBackOffice implements CalendarBackOffice {
  constructor(private readonly calendar: Pick<GoogleCalendar, "listBookingsInRange" | "deleteBookingById">) {}

  listBookings(range: BackOfficeRange): Promise<BackOfficeBookingList> {
    return this.calendar.listBookingsInRange(range);
  }

  cancelBookingById(bookingId: number): Promise<"deleted" | "not_found"> {
    return this.calendar.deleteBookingById(bookingId);
  }
}

export interface GoogleCalendarOptions {
  clientConfig: ClientConfig;
  serviceAccount: { jsonPath?: string; jsonB64?: string } | ServiceAccountCredentials;
  timeoutMs: number;
  logger: Logger;
  /** Solo tests: `fetch` falso. */
  fetch?: FetchLike;
  now?: () => number;
  newBookingId?: () => number;
}

function buildCalendar(opts: GoogleCalendarOptions): GoogleCalendar {
  const credentials =
    "private_key" in opts.serviceAccount ? opts.serviceAccount : loadServiceAccount(opts.serviceAccount);
  const now = opts.now ?? Date.now;
  const api = new GoogleApi({
    credentials,
    fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
    timeoutMs: opts.timeoutMs,
    now,
  });
  return new GoogleCalendar({
    api,
    settings: googleSettingsFromClientConfig(opts.clientConfig),
    logger: opts.logger,
    now,
    ...(opts.newBookingId ? { newBookingId: opts.newBookingId } : {}),
  });
}

/** Adaptador de la cuenta de reservas. Falla al construir si falta la credencial o el horario. */
export function createGoogleCalendar(opts: GoogleCalendarOptions): GoogleCalendar {
  return buildCalendar(opts);
}

/** Back office con su propio cliente y token (misma cuenta de servicio). */
export function createGoogleCalendarBackOffice(opts: GoogleCalendarOptions): GoogleCalendarBackOffice {
  return new GoogleCalendarBackOffice(buildCalendar(opts));
}
