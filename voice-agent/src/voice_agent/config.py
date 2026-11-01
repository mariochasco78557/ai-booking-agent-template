"""Configuración por variables de entorno.

Reglas:
- En modo ``offline`` (por defecto) el servidor arranca sin ninguna clave, pero no
  atiende llamadas reales: sirve para el simulador, los tests y comprobar la salud.
- En modo ``real`` se niega a arrancar si falta cualquier clave necesaria. El error
  lista NOMBRES de variables, nunca valores.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import urlparse

MODES = ("offline", "real")
TTS_PROVIDERS = ("azure", "elevenlabs", "cartesia", "deepgram")
PROMPT_STRATEGIES = ("nodos", "completo")
OVERFLOW_ACTIONS = ("dial", "reject")
LOG_LEVELS = ("debug", "info", "warning", "error")
TURN_DETECTIONS = ("deepgram_flux", "smart_turn", "vad")
DEFAULT_FLUX_URL = "wss://api.eu.deepgram.com/v2/listen"  # endpoint de la UE (docs de Deepgram)
# Igual que AI_BOOKING_WEBHOOK_SECRET en el middleware (src/config/env.ts: mínimo 32).
BOOKING_SECRET_MIN_LENGTH = 32

DEFAULT_GREETING = (
    "Hola, has llamado a Chimac Peluqueros. Soy el asistente virtual. "
    "¿Qué necesitas: corte de pelo, barba, o corte y barba?"
)

# Palabras que Deepgram debe reconocer mejor (servicios, nombres del salón).
DEFAULT_KEYTERMS = (
    "Chimac",
    "Demo Salon",
    "corte de pelo",
    "barba",
    "corte y barba",
    "Bruno",
    "Olga",
    "Ramón",
    "cita",
    "WhatsApp",
)

E164_RE = re.compile(r"^\+[1-9]\d{6,14}$")


class ConfigError(ValueError):
    """La configuración no permite arrancar en el modo pedido."""


def _str(env: Mapping[str, str], name: str, default: str = "") -> str:
    return env.get(name, default).strip()


def _bool(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    value = raw.strip().lower()
    if value in ("1", "true", "yes", "si", "sí", "on"):
        return True
    if value in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"{name}: valor booleano no válido")


def _int(env: Mapping[str, str], name: str, default: int, lo: int, hi: int) -> int:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError as exc:
        raise ConfigError(f"{name}: debe ser un número entero") from exc
    if not lo <= value <= hi:
        raise ConfigError(f"{name}: debe estar entre {lo} y {hi}")
    return value


def _float(env: Mapping[str, str], name: str, default: float, lo: float, hi: float) -> float:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw.strip())
    except ValueError as exc:
        raise ConfigError(f"{name}: debe ser un número") from exc
    if not lo <= value <= hi:
        raise ConfigError(f"{name}: debe estar entre {lo} y {hi}")
    return value


def _choice(env: Mapping[str, str], name: str, default: str, options: tuple[str, ...]) -> str:
    value = _str(env, name, default).lower() or default
    if value not in options:
        raise ConfigError(f"{name}: debe ser uno de {', '.join(options)}")
    return value


@dataclass(frozen=True)
class Settings:
    mode: str = "offline"
    enabled: bool = False
    public_base_url: str = ""
    host: str = "0.0.0.0"
    port: int = 8080

    twilio_account_sid: str = ""
    twilio_auth_token: str = field(default="", repr=False)
    twilio_region: str = "ie1"
    twilio_edge: str = "dublin"

    max_concurrent_calls: int = 3
    overflow_action: str = "reject"
    fallback_dial_number: str = ""

    deepgram_api_key: str = field(default="", repr=False)
    deepgram_model: str = "nova-3"
    deepgram_language: str = "es"
    deepgram_keyterms: tuple[str, ...] = DEFAULT_KEYTERMS

    # Fin de turno ((internal doc, not included in the template) §3 bis)
    turn_detection: str = "deepgram_flux"
    vad_stop_secs: float = 0.8
    smart_turn_model: str = ""
    smart_turn_threads: int = 1
    smart_turn_shared: bool = True
    deepgram_flux_model: str = "flux-general-multi"
    deepgram_flux_url: str = DEFAULT_FLUX_URL
    flux_eot_threshold: float | None = None
    flux_eot_timeout_ms: int | None = None
    flux_chunk_ms: int = 80

    anthropic_api_key: str = field(default="", repr=False)
    llm_model: str = "claude-haiku-4-5"
    llm_max_tokens: int = 300
    llm_temperature: float = 0.0
    llm_timeout_s: float = 10.0
    prompt_strategy: str = "nodos"

    tts_provider: str = "azure"
    azure_speech_key: str = field(default="", repr=False)
    azure_speech_region: str = "westeurope"
    azure_tts_voice: str = "es-ES-ElviraNeural"
    elevenlabs_api_key: str = field(default="", repr=False)
    elevenlabs_voice_id: str = ""
    elevenlabs_model: str = "eleven_flash_v2_5"
    cartesia_api_key: str = field(default="", repr=False)
    cartesia_voice_id: str = ""
    deepgram_tts_voice: str = "aura-2-carina-es"

    middleware_base_url: str = "http://middleware:3000"
    middleware_webhook_secret: str = field(default="", repr=False)
    middleware_booking_secret: str = field(default="", repr=False)
    middleware_agent_profile: str = "v5"
    middleware_availability_timeout_s: float = 10.0
    middleware_book_timeout_s: float = 8.0

    greeting_text: str = DEFAULT_GREETING
    salon_timezone: str = "Europe/Madrid"
    silence_prompt_s: float = 8.0
    silence_hangup_s: float = 30.0
    max_call_s: int = 600

    call_log_dir: str = "/var/lib/demo-salon-voice/calls"
    call_log_retention_days: int = 30
    log_level: str = "info"

    @property
    def is_real(self) -> bool:
        return self.mode == "real"

    @property
    def websocket_url(self) -> str:
        """URL wss:// que se pone en el TwiML <Stream>."""
        parsed = urlparse(self.public_base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return f"{scheme}://{parsed.netloc}{parsed.path.rstrip('/')}/voice/twilio/ws"

    @property
    def incoming_url(self) -> str:
        """URL pública exacta que Twilio firma en el POST de llamada entrante."""
        return f"{self.public_base_url.rstrip('/')}/voice/twilio/incoming"


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Lee y valida la configuración. Lanza ConfigError si no es válida."""
    env = dict(os.environ) if env is None else env

    keyterms_raw = _str(env, "DEEPGRAM_KEYTERMS")
    keyterms = (
        tuple(t.strip() for t in keyterms_raw.split(",") if t.strip())
        if keyterms_raw
        else DEFAULT_KEYTERMS
    )
    fallback = _str(env, "FALLBACK_DIAL_NUMBER")
    overflow_default = "dial" if fallback else "reject"

    settings = Settings(
        mode=_choice(env, "VOICE_AGENT_MODE", "offline", MODES),
        enabled=_bool(env, "VOICE_AGENT_ENABLED", False),
        public_base_url=_str(env, "PUBLIC_BASE_URL"),
        host=_str(env, "HOST", "0.0.0.0"),
        port=_int(env, "PORT", 8080, 1, 65535),
        twilio_account_sid=_str(env, "TWILIO_ACCOUNT_SID"),
        twilio_auth_token=_str(env, "TWILIO_AUTH_TOKEN"),
        twilio_region=_str(env, "TWILIO_REGION", "ie1"),
        twilio_edge=_str(env, "TWILIO_EDGE", "dublin"),
        max_concurrent_calls=_int(env, "MAX_CONCURRENT_CALLS", 3, 1, 20),
        overflow_action=_choice(env, "OVERFLOW_ACTION", overflow_default, OVERFLOW_ACTIONS),
        fallback_dial_number=fallback,
        deepgram_api_key=_str(env, "DEEPGRAM_API_KEY"),
        deepgram_model=_str(env, "DEEPGRAM_MODEL", "nova-3"),
        deepgram_language=_str(env, "DEEPGRAM_LANGUAGE", "es"),
        deepgram_keyterms=keyterms,
        turn_detection=_choice(env, "TURN_DETECTION", "deepgram_flux", TURN_DETECTIONS),
        vad_stop_secs=_float(env, "VAD_STOP_SECS", 0.8, 0.3, 2.0),
        smart_turn_model=_str(env, "SMART_TURN_MODEL"),
        smart_turn_threads=_int(env, "SMART_TURN_THREADS", 1, 1, 8),
        smart_turn_shared=_bool(env, "SMART_TURN_SHARED_SESSION", True),
        deepgram_flux_model=_str(env, "DEEPGRAM_FLUX_MODEL", "flux-general-multi"),
        deepgram_flux_url=_str(env, "DEEPGRAM_FLUX_URL", DEFAULT_FLUX_URL),
        flux_eot_threshold=_float(env, "FLUX_EOT_THRESHOLD", 0.7, 0.5, 0.9) if env.get("FLUX_EOT_THRESHOLD", "").strip() else None,
        flux_eot_timeout_ms=_int(env, "FLUX_EOT_TIMEOUT_MS", 5000, 500, 10000) if env.get("FLUX_EOT_TIMEOUT_MS", "").strip() else None,
        flux_chunk_ms=_int(env, "FLUX_CHUNK_MS", 80, 20, 200),
        anthropic_api_key=_str(env, "ANTHROPIC_API_KEY"),
        llm_model=_str(env, "LLM_MODEL", "claude-haiku-4-5"),
        llm_max_tokens=_int(env, "LLM_MAX_TOKENS", 300, 50, 2000),
        llm_temperature=_float(env, "LLM_TEMPERATURE", 0.0, 0.0, 1.0),
        llm_timeout_s=_float(env, "LLM_TIMEOUT_S", 10.0, 2.0, 60.0),
        prompt_strategy=_choice(env, "PROMPT_STRATEGY", "nodos", PROMPT_STRATEGIES),
        tts_provider=_choice(env, "TTS_PROVIDER", "azure", TTS_PROVIDERS),
        azure_speech_key=_str(env, "AZURE_SPEECH_KEY"),
        azure_speech_region=_str(env, "AZURE_SPEECH_REGION", "westeurope"),
        azure_tts_voice=_str(env, "AZURE_TTS_VOICE", "es-ES-ElviraNeural"),
        elevenlabs_api_key=_str(env, "ELEVENLABS_API_KEY"),
        elevenlabs_voice_id=_str(env, "ELEVENLABS_VOICE_ID"),
        elevenlabs_model=_str(env, "ELEVENLABS_MODEL", "eleven_flash_v2_5"),
        cartesia_api_key=_str(env, "CARTESIA_API_KEY"),
        cartesia_voice_id=_str(env, "CARTESIA_VOICE_ID"),
        deepgram_tts_voice=_str(env, "DEEPGRAM_TTS_VOICE", "aura-2-carina-es"),
        middleware_base_url=_str(env, "MIDDLEWARE_BASE_URL", "http://middleware:3000"),
        middleware_webhook_secret=_str(env, "MIDDLEWARE_WEBHOOK_SECRET"),
        middleware_booking_secret=_str(env, "MIDDLEWARE_BOOKING_SECRET"),
        middleware_agent_profile=_str(env, "MIDDLEWARE_AGENT_PROFILE", "v5"),
        middleware_availability_timeout_s=_float(
            env, "MIDDLEWARE_AVAILABILITY_TIMEOUT_S", 10.0, 1.0, 30.0
        ),
        middleware_book_timeout_s=_float(env, "MIDDLEWARE_BOOK_TIMEOUT_S", 8.0, 1.0, 30.0),
        greeting_text=_str(env, "GREETING_TEXT") or DEFAULT_GREETING,
        salon_timezone=_str(env, "SALON_TIMEZONE", "Europe/Madrid"),
        silence_prompt_s=_float(env, "SILENCE_PROMPT_S", 8.0, 2.0, 60.0),
        silence_hangup_s=_float(env, "SILENCE_HANGUP_S", 30.0, 10.0, 300.0),
        max_call_s=_int(env, "MAX_CALL_S", 600, 60, 3600),
        call_log_dir=_str(env, "CALL_LOG_DIR", "/var/lib/demo-salon-voice/calls"),
        call_log_retention_days=_int(env, "CALL_LOG_RETENTION_DAYS", 30, 1, 365),
        log_level=_choice(env, "LOG_LEVEL", "info", LOG_LEVELS),
    )
    validate(settings)
    return settings


def missing_for_real(s: Settings) -> list[str]:
    """Nombres de variables que faltan para el modo real (nunca valores)."""
    missing: list[str] = []
    required = {
        "PUBLIC_BASE_URL": s.public_base_url,
        "TWILIO_ACCOUNT_SID": s.twilio_account_sid,
        "TWILIO_AUTH_TOKEN": s.twilio_auth_token,
        "DEEPGRAM_API_KEY": s.deepgram_api_key,
        "ANTHROPIC_API_KEY": s.anthropic_api_key,
        "MIDDLEWARE_BASE_URL": s.middleware_base_url,
        "MIDDLEWARE_WEBHOOK_SECRET": s.middleware_webhook_secret,
        # En producción, con la reserva activada, el middleware exige AI_BOOKING_WEBHOOK_SECRET
        # (src/config/env.ts) y rechaza /ai/voice/v2/book sin X-AI-Booking-Secret.
        "MIDDLEWARE_BOOKING_SECRET": s.middleware_booking_secret,
    }
    tts_required = {
        "azure": {"AZURE_SPEECH_KEY": s.azure_speech_key, "AZURE_SPEECH_REGION": s.azure_speech_region},
        "elevenlabs": {
            "ELEVENLABS_API_KEY": s.elevenlabs_api_key,
            "ELEVENLABS_VOICE_ID": s.elevenlabs_voice_id,
        },
        "cartesia": {"CARTESIA_API_KEY": s.cartesia_api_key, "CARTESIA_VOICE_ID": s.cartesia_voice_id},
        "deepgram": {"DEEPGRAM_TTS_VOICE": s.deepgram_tts_voice},
    }[s.tts_provider]
    required.update(tts_required)
    for name, value in required.items():
        if not value:
            missing.append(name)
    return missing


def validate(s: Settings) -> None:
    """Comprueba la coherencia. En modo real exige todas las claves."""
    problems: list[str] = []

    if s.middleware_agent_profile != "v5":
        # El contrato de producción (TOOL_SCHEMAS_BALANCED_V5.json) solo admite "v5".
        problems.append("MIDDLEWARE_AGENT_PROFILE: el único valor admitido es v5")
    if s.fallback_dial_number and not E164_RE.match(s.fallback_dial_number):
        problems.append("FALLBACK_DIAL_NUMBER: debe ir en formato E.164 (+34…)")
    if s.overflow_action == "dial" and not s.fallback_dial_number:
        problems.append("OVERFLOW_ACTION=dial necesita FALLBACK_DIAL_NUMBER")
    if s.silence_hangup_s <= s.silence_prompt_s * 2:
        problems.append("SILENCE_HANGUP_S debe ser mayor que dos avisos de silencio (SILENCE_PROMPT_S × 2)")
    if s.turn_detection == "deepgram_flux":
        if not s.deepgram_flux_model.startswith("flux-general"):
            problems.append("DEEPGRAM_FLUX_MODEL: debe ser un modelo Flux (flux-general-multi)")
        elif s.deepgram_flux_model == "flux-general-en" and not s.deepgram_language.startswith("en"):
            problems.append("DEEPGRAM_FLUX_MODEL: flux-general-en solo entiende inglés; para español, flux-general-multi")
        if not s.deepgram_flux_url.startswith("wss://"):
            problems.append("DEEPGRAM_FLUX_URL: debe empezar por wss://")
    if s.turn_detection == "smart_turn" and s.smart_turn_model:
        from pathlib import Path

        if not Path(s.smart_turn_model).is_file():
            problems.append("SMART_TURN_MODEL: no existe el fichero del modelo")
    mw = urlparse(s.middleware_base_url)
    if mw.scheme not in ("http", "https") or not mw.netloc:
        problems.append("MIDDLEWARE_BASE_URL: URL no válida")

    if s.is_real:
        missing = missing_for_real(s)
        if missing:
            problems.append("modo real sin: " + ", ".join(missing))
        if s.middleware_booking_secret and len(s.middleware_booking_secret) < BOOKING_SECRET_MIN_LENGTH:
            problems.append(
                f"MIDDLEWARE_BOOKING_SECRET: debe tener al menos {BOOKING_SECRET_MIN_LENGTH} caracteres, como en el middleware"
            )
        if s.public_base_url:
            pub = urlparse(s.public_base_url)
            if pub.scheme != "https" or not pub.netloc:
                problems.append("PUBLIC_BASE_URL: en modo real debe ser https://")

    if problems:
        raise ConfigError("Configuración no válida: " + "; ".join(problems))
