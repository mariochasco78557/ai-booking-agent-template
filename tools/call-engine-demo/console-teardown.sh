#!/usr/bin/env bash
# Demo Salon — parada de la consola operativa local (step 13).
#
# REGLA DE SEGURIDAD, DELIBERADA: este script SOLO para el proceso apuntado
# por su propio fichero de PID (tools/call-engine-demo/.console.pid, escrito
# por console.sh). Nunca mata procesos por nombre ni por puerto. El puerto
# 3000 de esta máquina puede pertenecer a un proceso AJENO del usuario
# `demo-salon` que no tiene absolutamente nada que ver con esta consola — este
# script nunca lo referencia, nunca lo comprueba y nunca lo toca.
set -euo pipefail

step() {
    echo
    echo "==> $*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${SCRIPT_DIR}/.console.pid"

step "Parando la consola operativa local de Demo Salon, solo por su propio fichero de PID"
echo "No se toca, ni se comprueba, el puerto 3000 de esta máquina en ningún momento."

if [ ! -f "${PID_FILE}" ]; then
    echo "${PID_FILE} no existe — esta consola no está en marcha (o ya se paró antes). Nada que hacer."
    exit 0
fi

pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
if [ -z "${pid}" ]; then
    echo "${PID_FILE} existía pero estaba vacío — lo elimino y salgo."
    rm -f -- "${PID_FILE}"
    exit 0
fi

if kill -0 "${pid}" 2>/dev/null; then
    echo "Parando el proceso propio ${pid} (registrado en ${PID_FILE})."
    kill "${pid}" 2>/dev/null || true
    attempt=0
    while [ "${attempt}" -lt 25 ]; do
        if ! kill -0 "${pid}" 2>/dev/null; then
            break
        fi
        attempt=$((attempt + 1))
        sleep 0.2
    done
    if kill -0 "${pid}" 2>/dev/null; then
        echo "El proceso ${pid} no ha terminado a tiempo con SIGTERM; forzando con SIGKILL." >&2
        kill -9 "${pid}" 2>/dev/null || true
    fi
else
    echo "${PID_FILE} existía pero no apuntaba a un proceso vivo — nada que parar."
fi

rm -f -- "${PID_FILE}"

echo
echo "TEARDOWN: PASS (no queda ningún proceso propio de esta consola)."
