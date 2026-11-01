# Plantilla de cliente
1. Copiar esta carpeta a `clientes/<cliente>/`.
2. Rellenar `cliente.yaml` (negocio, horarios, servicios, empleados, tono, canales, calendario, límites).
3. Copiar `.env.example` a `.env` en el despliegue del cliente.

**Los secretos (claves, tokens, contraseñas) van en `.env`, nunca en `cliente.yaml` ni en git.**
`.env` está ignorado por git; `.env.example` solo lleva nombres de variables.

## Calendario en Google Calendar (`google-calendar`, por defecto para negocios sin sistema de reservas)
1. **Cuenta de servicio** (Google Cloud Console, proyecto del negocio o de Flowara):
   APIs y servicios > Biblioteca > activar **Google Calendar API**; IAM > Cuentas de servicio > Crear;
   en la cuenta creada, Claves > Añadir clave > JSON. Guardar el JSON **fuera del repo** (p. ej. `/etc/flowara/<cliente>/`,
   permisos 600). No hace falta delegación de dominio.
2. **Compartir los calendarios**: en Google Calendar del negocio, Configuración del calendario > Compartir con personas
   concretas > añadir el correo de la cuenta de servicio (`...@...iam.gserviceaccount.com`) con
   **«Hacer cambios en eventos»**. Uno por empleado, o uno solo para todo el negocio.
3. **`cliente.yaml`**: `horario` (obligatorio con Google), `zona_horaria`, `servicios` con `id` y `duracion_min`,
   `empleados[].calendario` = id del calendario (Configuración > Integrar el calendario > ID del calendario) o
   `calendario.google.calendario_unico`; opcional `calendario.google.paso_min` y `empleados[].id`.
4. **`.env`**: `CALENDAR_PROVIDER=google-calendar` y **una** de `GOOGLE_SERVICE_ACCOUNT_JSON=<ruta>` o
   `GOOGLE_SERVICE_ACCOUNT_JSON_B64=<json en base64>` (`base64 -w0 clave.json`). `BOOKING_USERNAME/PASSWORD` no hacen falta.
5. **Prueba**: con `ENABLE_WRITE_OPERATIONS=false` comprobar huecos; las escrituras reales, solo con aprobación humana.

Las citas quedan como eventos `<servicio> - <cliente>` con el teléfono en la descripción. Detalle:
`src/adapters/calendar/google-calendar/README.md`.
