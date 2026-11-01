# Adaptador `google-calendar` (fase 3, v0.6.0)

Adaptador por defecto para negocios sin sistema de reservas propio. Implementa `CalendarProvider` y
`CalendarBackOffice` sobre Google Calendar v3. Decisiones: (internal doc, not included in the template) D-014.

Se activa con `CALENDAR_PROVIDER=google-calendar` (el valor por defecto es `memory`: este mismo adaptador contra un emulador en memoria).

## Ficheros
- `googleApi.ts`: cliente REST mínimo sobre `fetch` y token de cuenta de servicio (JWT RS256 firmado con
  `node:crypto`). Sin dependencias npm. Ámbitos: `calendar.events` y `calendar.freebusy`.
- `settings.ts`: traduce `cliente.yaml` (empleados, servicios, horario, cierres, zona horaria).
- `timezone.ts`: hora de pared <-> instante en cualquier zona del tz database con `Intl.DateTimeFormat`.
- `index.ts`: el adaptador (`GoogleCalendar`), el back office y las factorías.

## Credencial (nunca en git)
Cuenta de servicio de Google Cloud con la API de Calendar activada. Una de estas variables (solo en `.env`):
- `GOOGLE_SERVICE_ACCOUNT_JSON`: ruta al JSON de la clave;
- `GOOGLE_SERVICE_ACCOUNT_JSON_B64`: el mismo JSON en base64.

El negocio comparte cada calendario con el correo de la cuenta de servicio con permiso
**«Hacer cambios en eventos»**. Con `CALENDAR_PROVIDER=google-calendar` no hacen falta `BOOKING_USERNAME/PASSWORD`.
Pasos detallados: `clientes/_plantilla/README.md`.

## Correspondencia con `cliente.yaml`
| Puerto | Google |
|---|---|
| recurso (empleado) | `empleados[]`; id numérico = `empleados[].id` o, si falta, su posición 1..n |
| calendario del recurso | `empleados[].calendario` (id de calendario) o `calendario.google.calendario_unico` |
| servicio | `servicios[]` (`id`, `nombre`, `duracion_min`); sin `id`, su posición 1..n |
| huecos | `horario` − ocupado, cada `calendario.google.paso_min` (por defecto `duracion_cita_min`) |
| días cerrados | `dias_cerrados`/día sin franjas, `cierres` (festivos), `cierre_temprano` |
| zona horaria | `zona_horaria` |

## Cita = evento
- `id` del evento: `fb` + id numérico de la cita con 15 dígitos (base32hex válido). El id numérico es el que ven el
  núcleo y WhatsApp (`CreatedBooking.id`, `cancelBookingById`); la referencia del modo asistente es el id del evento.
- `summary`: `<servicio> - <nombre y apellidos del cliente>`; `description`: teléfono, servicio, profesional y ref.
- `start`/`end`: hora local + `timeZone` de `cliente.yaml`; duración del servicio.
- `extendedProperties.private`: `flowara.bookingId`, `flowara.phone` (E.164), `flowara.serviceId`,
  `flowara.employeeId`, `flowara.ownerName`, `flowara.ownerSurnames`.

## Operaciones
- `ensureSession`/`resetSession`: pedir o descartar el token OAuth (un 401 lo descarta solo).
- `listResourcesForDay`: empleados del `cliente.yaml` si el negocio abre ese día, con calendario accesible y no ocupados
  todo el horario (p. ej. un evento de día completo «Vacaciones»). Día cerrado: `[]` sin llamar a Google.
- `listFreeSlots`: `freeBusy` de los calendarios + horario; recurso sin hueco ausente; sin horas pasadas.
- `createBooking`: comprueba el hueco e inserta, en serie por calendario dentro del proceso. Ocupado o fuera de horario:
  `UpstreamError` 409 «ya no están disponibles» (el núcleo lo trata como hueco tomado).
- Modo asistente: `checkAvailability` (`CLOSED_HOLIDAY` en `cierres`), `checkSlot`, `createCheckedBooking`
  (`DUPLICATE_CALLER_BOOKING` si el teléfono ya tiene una cita futura, `SLOT_TAKEN`), `findBookingsByPhone`
  (`privateExtendedProperty=flowara.phone=<e164>`, solo futuras, máx. 3 o `AMBIGUOUS`),
  `requestCancellationProof` y `cancelBooking` (ver aproximaciones).
- Back office: `listBookings` (eventos con `flowara.bookingId` del rango; los creados a mano no se listan) y
  `cancelBookingById` (borra el evento; ya borrado o inexistente: `"not_found"`).
- Extra fuera del puerto: `moveBooking(id, fecha)` = `events.patch` tras comprobar el hueco nuevo.

## Aproximaciones (Google no tiene el concepto)
- **Justificante de anulación:** lo emite el adaptador en memoria con las reglas del contrato Symfony (nombre y
  teléfono deben coincidir; 120 s; un uso; ligado a una cita; 3 intentos por cita y hora; solo se guarda el sha256).
  Un reinicio del proceso invalida los justificantes pendientes (el cliente vuelve a pedirlo).
- **Anular = borrar** (`events.delete`); Google deja el evento en `cancelled` y deja de ocupar.
- **Carreras:** el cerrojo es por proceso. Dos procesos, o alguien editando el calendario a mano en el mismo segundo,
  pueden solaparse; Google no tiene restricción de unicidad por hueco.
- **Calendario único:** un evento sin `flowara.employeeId` (creado a mano) ocupa a todos los empleados.
- `listResourcesForDay` usa el horario del negocio, no uno por empleado.
