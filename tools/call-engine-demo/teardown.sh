#!/usr/bin/env bash
# Demo Salon — demostración del motor de llamadas: desmontaje.
#
# Esta demostración nunca arranca ningún servidor ni abre ningún puerto —
# tools/call-engine-demo/demo-driver.ts ejecuta el motor real dentro de un
# único proceso de línea de comandos que termina solo, en cuanto acaba de
# imprimir la última escena. No hay ningún contenedor, ninguna base de
# datos ni ningún proceso en segundo plano que esta demostración deje vivo.
#
# REGLA DE SEGURIDAD, DELIBERADA: este script NUNCA mata procesos por
# nombre ni por puerto. En esta máquina puede haber, en el puerto 3000, un
# proceso AJENO del usuario `demo-salon` que no tiene absolutamente nada que ver
# con esta demostración — no se debe tocar bajo ningún concepto. Si esta
# demostración llegara a arrancar algo propio en el futuro, sería a través
# de un fichero de PID propio (p. ej. tools/call-engine-demo/.demo.pid) y
# este script solo pararía ESE proceso, nunca "lo que haya en tal puerto" ni
# "lo que se llame de tal forma".
set -euo pipefail

step() {
    echo
    echo "==> $*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${SCRIPT_DIR}/.demo.pid"

step "Comprobando si esta demostración dejó algún proceso propio en marcha"
if [ -f "${PID_FILE}" ]; then
    demo_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [ -n "${demo_pid}" ] && kill -0 "${demo_pid}" 2>/dev/null; then
        echo "  parando el proceso propio ${demo_pid} (registrado en ${PID_FILE})"
        kill "${demo_pid}" 2>/dev/null || true
    else
        echo "  ${PID_FILE} existía pero no apuntaba a un proceso vivo — nada que parar"
    fi
    rm -f -- "${PID_FILE}"
else
    echo "  ${PID_FILE} no existe — esta demostración no arranca ningún proceso propio en"
    echo "  segundo plano (cada ejecución de demo.sh es un único proceso que termina solo);"
    echo "  no hay nada que parar."
fi

echo
echo "Nota: si hay un proceso ajeno del usuario 'demo-salon' escuchando en el puerto 3000,"
echo "este script no lo toca ni lo comprueba — no tiene relación con esta demostración."

step "TEARDOWN: PASS (no queda ningún proceso propio de esta demostración)"
