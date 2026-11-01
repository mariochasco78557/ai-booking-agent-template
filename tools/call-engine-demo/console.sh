#!/usr/bin/env bash
# Demo Salon — arranque de la consola operativa local (step 13).
#
# Arranca SU PROPIO proceso Fastify, separado por completo del middleware
# real (src/app.ts) — nunca lo monta encima, nunca reutiliza su instancia.
# Solo escucha en 127.0.0.1 (loopback) y solo si CALL_ENGINE_CONSOLE_ENABLED
# está activado; ambas cosas las decide src/console/server.ts, no este
# script. Este script se limita a: activar el interruptor, arrancar el
# proceso en segundo plano con `tsx`, esperar (con un límite) a que responda
# de verdad, y anotar su PID en un fichero PROPIO de este script
# (.console.pid) para que console-teardown.sh pueda pararlo con seguridad.
#
# REGLA DE SEGURIDAD, DELIBERADA: el puerto 3000 de esta máquina puede
# pertenecer a un proceso AJENO del usuario `demo-salon` que no tiene nada que
# ver con esta consola — este script nunca lo referencia, nunca lo
# comprueba y nunca lo toca. El puerto por defecto de esta consola es 4310,
# configurable con CALL_ENGINE_CONSOLE_PORT si hiciera falta. Si ese puerto
# ya está ocupado, src/console/server.ts falla con un error explícito (no
# hay autoincremento silencioso) y este script se limita a mostrar ese
# error y salir con código distinto de cero.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TSX_BIN="${PROJECT_ROOT}/node_modules/.bin/tsx"
SERVER_ENTRY="${PROJECT_ROOT}/src/console/server.ts"
PID_FILE="${SCRIPT_DIR}/.console.pid"
LOG_FILE="${SCRIPT_DIR}/.console.log"

PORT="${CALL_ENGINE_CONSOLE_PORT:-4310}"

if [ -f "${PID_FILE}" ]; then
    existing_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [ -n "${existing_pid}" ] && kill -0 "${existing_pid}" 2>/dev/null; then
        echo "La consola ya está en marcha (PID ${existing_pid}, registrado en ${PID_FILE})."
        echo "  URL: http://127.0.0.1:${PORT}/"
        exit 0
    fi
    echo "${PID_FILE} apuntaba a un proceso que ya no existe — lo elimino antes de arrancar de nuevo."
    rm -f -- "${PID_FILE}"
fi

if [ ! -x "${TSX_BIN}" ]; then
    echo "No encuentro tsx en ${TSX_BIN}. Ejecuta 'npm install' en ${PROJECT_ROOT} primero." >&2
    exit 1
fi

# HONESTIDAD DEL ARRANQUE, añadida tras encontrar el fallo de verdad. La espera
# de más abajo pregunta al PUERTO, no al proceso. Con el guardián de ejecución
# directa roto (comparaba una URL percent-encoded con una ruta, así que con
# espacios en la ruta nunca arrancaba), el proceso lanzado moría en silencio y
# una consola huérfana de una sesión anterior contestaba en 4310: este script
# declaraba PASS, escribía en .console.pid un PID ya muerto y console-teardown.sh
# decía «nada que parar» dejando viva la consola de verdad.
#
# Si algo contesta en el puerto ANTES de lanzar nada, no es nuestro —el caso
# «ya está en marcha» lo resuelve el fichero de PID de arriba— y se dice.
if curl -fsS "http://127.0.0.1:${PORT}/api/snapshot" >/dev/null 2>&1; then
    echo "Ya hay algo contestando en http://127.0.0.1:${PORT}/ que NO es un proceso de este script." >&2
    echo "Puede ser una consola huérfana de una sesión anterior. Compruébalo con:" >&2
    echo "    lsof -nP -iTCP:${PORT} -sTCP:LISTEN" >&2
    echo "…y párala antes de volver a arrancar, o usa CALL_ENGINE_CONSOLE_PORT=<otro puerto libre>." >&2
    echo "No se arranca nada: declarar que ha arrancado sería mentir." >&2
    exit 1
fi

echo "==> Arrancando la consola operativa local de Demo Salon — solo 127.0.0.1, datos sintéticos."
echo "    (no toca, ni comprueba, el puerto 3000 de esta máquina)"

CALL_ENGINE_CONSOLE_ENABLED=1 CALL_ENGINE_CONSOLE_PORT="${PORT}" \
    nohup "${TSX_BIN}" "${SERVER_ENTRY}" >"${LOG_FILE}" 2>&1 &
NEW_PID=$!
echo "${NEW_PID}" > "${PID_FILE}"

ATTEMPTS=0
MAX_ATTEMPTS=50
READY=0
while [ "${ATTEMPTS}" -lt "${MAX_ATTEMPTS}" ]; do
    if ! kill -0 "${NEW_PID}" 2>/dev/null; then
        break
    fi
    if curl -fsS "http://127.0.0.1:${PORT}/api/snapshot" >/dev/null 2>&1; then
        READY=1
        break
    fi
    ATTEMPTS=$((ATTEMPTS + 1))
    sleep 0.2
done

if [ "${READY}" -ne 1 ]; then
    echo "La consola no ha arrancado correctamente. Salida del proceso:" >&2
    cat "${LOG_FILE}" >&2 2>/dev/null || true
    kill "${NEW_PID}" 2>/dev/null || true
    rm -f -- "${PID_FILE}"
    exit 1
fi

# Y quien contesta tiene que ser NUESTRO proceso, no cualquiera que pasara por
# el puerto entre medias. Sin esta comprobación, «responde el puerto» y «arrancó
# la consola» son dos afirmaciones distintas que este script confundía.
if ! kill -0 "${NEW_PID}" 2>/dev/null; then
    echo "El puerto ${PORT} contesta, pero el proceso que lanzó este script (PID ${NEW_PID}) ya no existe." >&2
    echo "Quien contesta es otro proceso: no se declara arrancada una consola que no está en marcha." >&2
    cat "${LOG_FILE}" >&2 2>/dev/null || true
    rm -f -- "${PID_FILE}"
    exit 1
fi

echo "Consola operativa local de Demo Salon escuchando en http://127.0.0.1:${PORT}/ (PID ${NEW_PID})."
echo "Demo local · Datos sintéticos · No producción."
echo "Para pararla: bash tools/call-engine-demo/console-teardown.sh"
