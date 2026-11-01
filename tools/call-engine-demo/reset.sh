#!/usr/bin/env bash
# Demo Salon — demostración del motor de llamadas: vuelta a un estado limpio.
#
# HONESTIDAD SOBRE EL ESTADO: esta demostración no guarda nada en disco ni
# en ninguna base de datos. Todo lo que "recuerda" (las llamadas, las
# reservas ficticias, los avisos internos) vive únicamente dentro de la
# memoria del proceso mientras tools/call-engine-demo/demo-driver.ts se está
# ejecutando (src/callEngine/store/memoryStore.ts). En cuanto ese proceso
# termina, ese estado desaparece por sí solo — no hay nada que "borrar" en
# ese sentido. Cada ejecución de demo.sh empieza, por tanto, ya en estado
# limpio, sin que este script tenga que hacer nada especial por ello.
#
# Lo que este script SÍ hace de verdad es borrar cualquier artefacto que una
# ejecución anterior (o una futura revisión de esta demo) pudiera haber
# dejado escrito bajo este mismo directorio — por ejemplo, una salida
# capturada a mano en tools/call-engine-demo/.demo-artifacts/. Si ese
# directorio no existe (el caso normal), lo dice y no falla.
set -euo pipefail

step() {
    echo
    echo "==> $*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ruta concreta, con nombre propio, nunca vacía — jamás un `rm -rf "${VAR}"`
# sobre una variable que pudiera resolver a una cadena vacía.
ARTIFACTS_DIR="${SCRIPT_DIR}/.demo-artifacts"

step "Estado en memoria de la demostración"
echo "  La demostración no guarda nada en disco: todo su estado vive dentro del"
echo "  proceso mientras se ejecuta demo.sh, y desaparece solo al terminar. No hay"
echo "  nada que reiniciar ahí — cada ejecución ya empieza limpia."

step "Comprobando artefactos generados bajo ${ARTIFACTS_DIR}"
if [ -n "${ARTIFACTS_DIR}" ] && [ -d "${ARTIFACTS_DIR}" ]; then
    rm -rf -- "${ARTIFACTS_DIR}"
    echo "  eliminado ${ARTIFACTS_DIR}"
else
    echo "  ${ARTIFACTS_DIR} no existe — nada que eliminar (es el caso normal)."
fi

step "RESET: PASS (tools/call-engine-demo/ vuelve a un estado limpio y repetible)"
