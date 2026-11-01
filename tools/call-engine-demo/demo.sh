#!/usr/bin/env bash
# Demo Salon — demostración local del motor de llamadas (step 13).
#
# LOCAL, SINTÉTICO, NO PRODUCCIÓN. Este script es un envoltorio muy fino:
# se limita a comprobar la terminal (color / ausencia de terminal) y a
# invocar tools/call-engine-demo/demo-driver.ts, que es quien ejecuta el
# motor real (src/callEngine/engine.ts, runConversation) diez veces, en el
# mismo proceso, contra una agenda enteramente sintética. No arranca ningún
# servidor, no abre ningún puerto, no hace ninguna llamada de red y no
# escribe ningún fichero.
#
# Cada frase que se muestra como "el sistema responde" viene directamente
# de resolver el phraseKey que el propio motor devolvió — nunca de una
# frase escrita a mano en este script ni en el driver.
#
# --no-pause: no espera a que se pulse Enter entre escenas (uso no
# interactivo / verify.sh). --tecnico: añade, además de la línea sencilla,
# detalle técnico (nunca en su lugar). Respeta NO_COLOR
# (https://no-color.org/): el propio driver desactiva el color si NO_COLOR
# está definida o si la salida no es una terminal.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DRIVER="${SCRIPT_DIR}/demo-driver.ts"
TSX_BIN="${PROJECT_ROOT}/node_modules/.bin/tsx"

for arg in "$@"; do
    case "${arg}" in
        --no-pause|--tecnico) ;;
        *)
            echo "Uso: bash tools/call-engine-demo/demo.sh [--no-pause] [--tecnico]" >&2
            exit 1
            ;;
    esac
done

if [ ! -x "${TSX_BIN}" ]; then
    echo "No encuentro tsx en ${TSX_BIN}. Ejecuta 'npm install' en ${PROJECT_ROOT} primero." >&2
    exit 1
fi

exec "${TSX_BIN}" "${DRIVER}" "$@"
