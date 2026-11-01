from __future__ import annotations

import json
from pathlib import Path

import pytest

VOICE_AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = VOICE_AGENT_DIR.parent
SCHEMA_PATH = REPO_DIR / "docs" / "elevenlabs" / "TOOL_SCHEMAS_BALANCED_V5.json"
V6_PROMPT_PATH = REPO_DIR / "docs" / "elevenlabs" / "AGENT_PROMPT_LEAN_V6_ES.md"


@pytest.fixture(scope="session")
def v5_schema() -> dict:
    if not SCHEMA_PATH.exists():
        pytest.skip("TOOL_SCHEMAS_BALANCED_V5.json no está junto al proyecto")
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def v6_prompt() -> str:
    if not V6_PROMPT_PATH.exists():
        pytest.skip("AGENT_PROMPT_LEAN_V6_ES.md no está junto al proyecto")
    return V6_PROMPT_PATH.read_text(encoding="utf-8")


REAL_ENV = {
    "VOICE_AGENT_MODE": "real",
    "VOICE_AGENT_ENABLED": "true",
    "PUBLIC_BASE_URL": "https://voz.example.test",
    "TWILIO_ACCOUNT_SID": "AC_placeholder",
    "TWILIO_AUTH_TOKEN": "token_placeholder",
    "DEEPGRAM_API_KEY": "dg_placeholder",
    "ANTHROPIC_API_KEY": "sk_placeholder",
    "AZURE_SPEECH_KEY": "az_placeholder",
    "MIDDLEWARE_BASE_URL": "http://middleware:3000",
    "MIDDLEWARE_WEBHOOK_SECRET": "wh_placeholder",
    "MIDDLEWARE_BOOKING_SECRET": "bk_placeholder_" + "x" * 32,
}


@pytest.fixture
def real_env() -> dict[str, str]:
    return dict(REAL_ENV)
