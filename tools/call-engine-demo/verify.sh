#!/usr/bin/env bash
# Demo Salon — demostración del motor de llamadas: puerta de verificación.
#
# Comprobación determinista, SIN RED, que valida:
#   (a) la demo se ejecuta y sale con código 0;
#   (b) aparecen las diez escenas;
#   (c) aparece el rótulo "Demo local · Datos sintéticos · No producción";
#   (d) determinismo: tres ejecuciones con --no-pause producen una salida
#       idéntica byte a byte (sha256, con sha256sum o shasum -a 256, lo que
#       haya disponible — ver sha256_of() más abajo);
#   (e) la salida no contiene ninguno de los patrones de dato personal
#       exigidos por la misión (phone, telefono, ... nif);
#   (f) la salida no contiene ninguna URL real ni el dominio real de Demo Salon;
#   (g) la salida no afirma una transferencia consumada;
#   (h) reset.sh y teardown.sh salen con código 0.
#
# Imprime un recuento final y sale 0 solo si TODO pasa. Un fallo al arrancar
# (falta un binario, falta un fichero) se cuenta como un FAIL, nunca se
# ignora en silencio.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO="${SCRIPT_DIR}/demo.sh"
RESET="${SCRIPT_DIR}/reset.sh"
TEARDOWN="${SCRIPT_DIR}/teardown.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf -- "${WORKDIR}"' EXIT

TOTAL_FAILURES=0
declare -a RESULT_LINES=()

# `sha256sum` es GNU coreutils: no existe de serie en macOS (que trae
# `shasum -a 256` en su lugar). Portabilidad step 14/T4: se elige en tiempo
# de ejecución el binario que exista, en vez de asumir Linux.
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        echo "ni sha256sum ni shasum están disponibles en este sistema" >&2
        return 1
    fi
}

record() {
    local name="$1" status="$2"
    if [ "${status}" -eq 0 ]; then
        RESULT_LINES+=("PASS  ${name}")
    else
        RESULT_LINES+=("FAIL  ${name}")
        TOTAL_FAILURES=$((TOTAL_FAILURES + 1))
    fi
}

echo "==> Verificación de tools/call-engine-demo/"
echo "    directorio de trabajo temporal: ${WORKDIR}"
echo

# -----------------------------------------------------------------------
# (a) la demo se ejecuta y sale con código 0.
# -----------------------------------------------------------------------
RUN1="${WORKDIR}/run1.log"
RUN2="${WORKDIR}/run2.log"
RUN3="${WORKDIR}/run3.log"

bash "${DEMO}" --no-pause >"${RUN1}" 2>"${WORKDIR}/run1.stderr"
run1_status=$?
if [ "${run1_status}" -ne 0 ]; then
    echo "    demo.sh --no-pause salió con código ${run1_status}:"
    tail -n 30 "${WORKDIR}/run1.stderr" | sed 's/^/      /'
fi
record "(a) demo.sh --no-pause se ejecuta y sale con código 0" "${run1_status}"

# -----------------------------------------------------------------------
# (b) aparecen las diez escenas.
# -----------------------------------------------------------------------
scenes_missing=0
if [ -s "${RUN1}" ]; then
    for n in 01 02 03 04 05 06 07 08 09 10; do
        if ! grep -qF "ESCENA ${n}" "${RUN1}"; then
            echo "    falta la escena ESCENA ${n}"
            scenes_missing=1
        fi
    done
else
    echo "    la salida capturada está vacía — no se puede comprobar ninguna escena"
    scenes_missing=1
fi
record "(b) aparecen las diez escenas" "${scenes_missing}"

# -----------------------------------------------------------------------
# (c) aparece el rótulo de aviso de sandbox.
# -----------------------------------------------------------------------
banner_status=0
required_banner="Demo local · Datos sintéticos · No producción"
if [ -s "${RUN1}" ] && grep -qF "${required_banner}" "${RUN1}"; then
    banner_status=0
else
    banner_status=1
    echo "    no aparece el rótulo '${required_banner}'"
fi
record "(c) aparece el rótulo de aviso de sandbox" "${banner_status}"

# -----------------------------------------------------------------------
# (d) determinismo: tres ejecuciones con --no-pause, salida idéntica byte a
#     byte (comparada con sha256_of() — sha256sum, o shasum -a 256 si el
#     primero no está disponible, ver esa función más arriba — y con cmp,
#     no solo con el código de salida de cada una).
# -----------------------------------------------------------------------
bash "${DEMO}" --no-pause >"${RUN2}" 2>"${WORKDIR}/run2.stderr"
run2_status=$?
bash "${DEMO}" --no-pause >"${RUN3}" 2>"${WORKDIR}/run3.stderr"
run3_status=$?

determinism_status=0
if [ "${run2_status}" -ne 0 ] || [ "${run3_status}" -ne 0 ]; then
    determinism_status=1
    echo "    una repetición de demo.sh --no-pause falló (run2=${run2_status} run3=${run3_status})"
elif [ ! -s "${RUN1}" ] || [ ! -s "${RUN2}" ] || [ ! -s "${RUN3}" ]; then
    determinism_status=1
    echo "    alguna de las tres capturas está vacía — una comparación sobre nada no es una prueba real"
else
    hash1="$(sha256_of "${RUN1}")"
    hash2="$(sha256_of "${RUN2}")"
    hash3="$(sha256_of "${RUN3}")"
    if [ "${hash1}" != "${hash2}" ] || [ "${hash1}" != "${hash3}" ]; then
        determinism_status=1
        echo "    los sha256 no coinciden: run1=${hash1} run2=${hash2} run3=${hash3}"
    fi
    if ! cmp -s "${RUN1}" "${RUN2}"; then
        determinism_status=1
        echo "    cmp run1/run2 difiere:"
        cmp "${RUN1}" "${RUN2}" 2>&1 | sed 's/^/      /'
    fi
    if ! cmp -s "${RUN1}" "${RUN3}"; then
        determinism_status=1
        echo "    cmp run1/run3 difiere:"
        cmp "${RUN1}" "${RUN3}" 2>&1 | sed 's/^/      /'
    fi
fi
record "(d) tres ejecuciones --no-pause producen salida idéntica byte a byte" "${determinism_status}"

# -----------------------------------------------------------------------
# (e) ningún patrón de dato personal en la salida.
# -----------------------------------------------------------------------
personal_data_status=0
personal_data_patterns=(
    "phone" "telefono" "telephone" "msisdn" "nombre" "apellido" "email"
    "transcript" "transcripcion" "audio" "recording" "grabacion"
    "direccion" "dni" "nif"
)
for pattern in "${personal_data_patterns[@]}"; do
    if grep -qiE "${pattern}" "${RUN1}" "${RUN2}" "${RUN3}"; then
        personal_data_status=1
        echo "    patrón de dato personal encontrado en la salida: ${pattern}"
    fi
done
record "(e) sin patrones de dato personal en la salida" "${personal_data_status}"

# -----------------------------------------------------------------------
# (f) ninguna URL real ni el dominio real de Demo Salon.
# -----------------------------------------------------------------------
url_status=0
if grep -qiE 'booking-example\.com|LegacyBackend|https?://' "${RUN1}" "${RUN2}" "${RUN3}"; then
    url_status=1
    echo "    se ha encontrado una URL o un dominio real en la salida"
fi
record "(f) sin URLs ni dominio real de Demo Salon en la salida" "${url_status}"

# -----------------------------------------------------------------------
# (g) nunca se afirma una transferencia consumada.
# -----------------------------------------------------------------------
transfer_status=0
if grep -qiE 'le paso con|te paso con|le atender(a|á) en' "${RUN1}" "${RUN2}" "${RUN3}"; then
    transfer_status=1
    echo "    se ha encontrado una frase que afirma una transferencia ya consumada"
fi
record "(g) nunca se afirma una transferencia consumada" "${transfer_status}"

# -----------------------------------------------------------------------
# (h) reset.sh y teardown.sh salen con código 0.
# -----------------------------------------------------------------------
bash "${RESET}" >"${WORKDIR}/reset.log" 2>&1
reset_status=$?
if [ "${reset_status}" -ne 0 ]; then
    tail -n 30 "${WORKDIR}/reset.log" | sed 's/^/      /'
fi
record "(h1) reset.sh sale con código 0" "${reset_status}"

bash "${TEARDOWN}" >"${WORKDIR}/teardown.log" 2>&1
teardown_status=$?
if [ "${teardown_status}" -ne 0 ]; then
    tail -n 30 "${WORKDIR}/teardown.log" | sed 's/^/      /'
fi
record "(h2) teardown.sh sale con código 0" "${teardown_status}"

# -----------------------------------------------------------------------
# Extra: --tecnico compone con --no-pause (demuestra que la bandera hace
# algo, sin ser uno de los ocho requisitos obligatorios (a)-(h)).
# -----------------------------------------------------------------------
TECNICO_LOG="${WORKDIR}/tecnico.log"
bash "${DEMO}" --no-pause --tecnico >"${TECNICO_LOG}" 2>&1
tecnico_status=$?
if [ "${tecnico_status}" -eq 0 ] && grep -qF "[detalle técnico]" "${TECNICO_LOG}"; then
    tecnico_status=0
else
    tecnico_status=1
    echo "    --tecnico no compone correctamente con --no-pause"
fi
record "(extra) --tecnico compone con --no-pause y añade detalle técnico" "${tecnico_status}"

# -----------------------------------------------------------------------
# Report
# -----------------------------------------------------------------------
echo
echo "==> Resultados"
for line in "${RESULT_LINES[@]}"; do
    echo "${line}"
done
echo

if [ "${TOTAL_FAILURES}" -eq 0 ]; then
    echo "VERIFY: PASS (todas las comprobaciones han pasado)"
    exit 0
else
    echo "VERIFY: FAIL (${TOTAL_FAILURES} comprobación(es) fallida(s))"
    exit 1
fi
