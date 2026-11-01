# Agente de voz de Demo Salon. Imagen slim, multi-etapa, usuario no root.
# NO construida en esta sesión (VPS compartida): pendiente de probar con `docker build`.
# Etiquetas comprobadas en los registros el 2026-10-04: ghcr.io/astral-sh/uv:0.12.13 y
# python:3.12-slim-bookworm existen (HTTP 200).

ARG PYTHON_IMAGE=python:3.12-slim-bookworm

# ── 1. Dependencias (con uv y el uv.lock fijado) ────────────────────────────
FROM ${PYTHON_IMAGE} AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.13 /uv /usr/local/bin/uv
# pyproject.toml dice python-preference = "managed" (para la VPS); en la imagen se usa
# SOLO el Python de la imagen base y nunca se descarga otro.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON_PREFERENCE=only-system \
    UV_PYTHON=/usr/local/bin/python3.12 \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev --no-editable

# ── 2. Ejecución ────────────────────────────────────────────────────────────
FROM ${PYTHON_IMAGE}
# libssl3 y libasound2: los necesita el SDK de Azure Speech. ca-certificates: TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 libasound2 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 voice \
 && useradd --system --uid 10001 --gid voice --home-dir /nonexistent --shell /usr/sbin/nologin voice \
 && mkdir -p /var/lib/demo-salon-voice/calls \
 && chown -R voice:voice /var/lib/demo-salon-voice
COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    OMP_NUM_THREADS=1 \
    CALL_LOG_DIR=/var/lib/demo-salon-voice/calls \
    PORT=8080
USER voice
VOLUME ["/var/lib/demo-salon-voice"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/voice/health', timeout=3).status == 200 else 1)"]
CMD ["voice-agent"]
