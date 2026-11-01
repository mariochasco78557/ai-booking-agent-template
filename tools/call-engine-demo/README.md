# Demostración local del motor de llamadas (step 13)

**Demo local · Datos sintéticos · No producción.**

Esta demostración enseña, en diez situaciones, cómo contesta el motor de
llamadas cuando alguien pide cita por teléfono. Todo lo que se ve —clientes,
profesionales, citas— está inventado para esta demostración: no está
conectada al sistema real de Demo Salon y no cambia ninguna agenda real.

El problema real que resuelve: hoy, cada llamada interrumpe a alguien del
equipo mientras tiene las manos ocupadas cortando el pelo a un cliente. Este
motor está pensado para contestar solo cuando puede hacerlo con seguridad, y
para avisar al equipo solo cuando de verdad hace falta una persona — nunca
en una reserva normal y corriente.

## El único comando que necesitas

```bash
bash tools/call-engine-demo/demo.sh
```

Pulsa Enter para avanzar de una escena a la siguiente. Si prefieres verlo
todo de un tirón, sin pausas:

```bash
bash tools/call-engine-demo/demo.sh --no-pause
```

Si además quieres ver el detalle técnico (para el owner, o para quien verifique
el trabajo) en cada escena, añade `--tecnico` — esto se AÑADE a lo que ya se
ve, nunca lo sustituye:

```bash
bash tools/call-engine-demo/demo.sh --tecnico
```

## Qué vas a ver

Diez escenas, en este orden:

1. Una reserva de corte de pelo con un profesional concreto.
2. Un cliente al que le da igual quién le atienda: se ve por qué el sistema
   elige a una persona y no a otra (según cuánto trabajo tiene ese día cada
   una).
3. Un cliente pide justo la hora que ya está ocupada: se le ofrece otro día
   u otra hora — nunca se le dice, sin más, que "está lleno".
4. Un cliente pide cita un día en que el local está cerrado (festivo).
5. Un cliente pide un profesional que no está disponible ese día: el
   sistema nunca dice por qué, y cuando el cliente acepta a cualquiera,
   queda asignado a otro profesional realmente libre.
6. Un cliente pide un servicio especial (por ejemplo, color): se deriva a
   una persona sin inventar ni una duración ni un hueco libre.
7. Se provoca a propósito un fallo técnico: el sistema nunca dice que la
   reserva se ha hecho cuando no es así.
8. Un cliente dice que es urgente: el sistema dice que ha SOLICITADO ayuda
   humana — nunca que ya se le está atendiendo ni en cuánto tiempo.
9. Se comparan dos casos: pedir ayuda genera un aviso interno para el
   equipo; una reserva normal y correcta, en cambio, no interrumpe a nadie.
10. Un cliente pide cancelar sin que se le pueda verificar la identidad
    (reconocer cómo llama no basta): no se cancela ni se cambia nada.

Cada respuesta que aparece como "Sistema:" es una frase real, generada en
ese mismo momento por el propio motor (`src/callEngine/engine.ts`) —
ninguna frase de resultado está escrita a mano en este script.

## Qué NO ocurre nunca durante esta demostración

- Ninguna llamada real a nadie.
- Ningún mensaje real enviado.
- Ningún dato real de ningún cliente.
- Ninguna conexión a internet.
- Ningún cambio en la agenda de verdad.
- Ningún servidor arrancado, ningún puerto abierto, ningún contenedor.

Todo el estado (las llamadas, las reservas ficticias, los avisos internos)
vive únicamente en la memoria del propio proceso mientras se ejecuta
`demo.sh`, y desaparece solo en cuanto termina.

## Cómo reiniciar

No hace falta, en realidad: cada ejecución de `demo.sh` ya empieza limpia
(no hay nada guardado entre una ejecución y la siguiente). Aun así, si
quieres comprobarlo o limpiar algún artefacto que una revisión futura de
esta demostración pudiera haber dejado, ejecuta:

```bash
bash tools/call-engine-demo/reset.sh
```

## Cómo desmontar

Esta demostración no deja ningún proceso en marcha (no arranca ningún
servidor). Aun así, existe un script de desmontaje por si en el futuro esto
cambiara:

```bash
bash tools/call-engine-demo/teardown.sh
```

Este script nunca para procesos por nombre ni por puerto — en esta máquina
puede haber un proceso ajeno del usuario `demo-salon` en el puerto 3000 que no
tiene relación con esta demostración y que nunca se toca.

## Verificación

```bash
bash tools/call-engine-demo/verify.sh
```

Comprueba, sin red y sin depender del azar, que la demostración se ejecuta
correctamente, que aparecen las diez escenas, que el aviso de "demo local"
está presente, que tres ejecuciones seguidas producen exactamente la misma
salida, que no aparece ningún dato personal ni ninguna URL real, que nunca
se afirma una transferencia como si ya se hubiera completado, y que
`reset.sh`/`teardown.sh` terminan correctamente.
