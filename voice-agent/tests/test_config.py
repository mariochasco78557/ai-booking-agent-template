from __future__ import annotations

import pytest

from voice_agent.config import ConfigError, load_settings, missing_for_real


def test_offline_starts_without_any_key():
    s = load_settings({})
    assert s.mode == "offline"
    assert s.enabled is False
    assert s.max_concurrent_calls == 3
    assert s.llm_model == "claude-haiku-4-5"
    assert s.deepgram_model == "nova-3" and s.deepgram_language == "es"
    assert s.tts_provider == "azure"
    assert s.middleware_agent_profile == "v5"
    assert s.prompt_strategy == "nodos"


def test_real_mode_with_all_keys_loads(real_env):
    s = load_settings(real_env)
    assert s.is_real
    assert s.websocket_url == "wss://voz.example.test/voice/twilio/ws"
    assert s.incoming_url == "https://voz.example.test/voice/twilio/incoming"


@pytest.mark.parametrize(
    "missing",
    [
        "ANTHROPIC_API_KEY",
        "DEEPGRAM_API_KEY",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_ACCOUNT_SID",
        "AZURE_SPEECH_KEY",
        "MIDDLEWARE_WEBHOOK_SECRET",
        "MIDDLEWARE_BOOKING_SECRET",
        "PUBLIC_BASE_URL",
    ],
)
def test_real_mode_refuses_to_start_without_a_key(real_env, missing):
    real_env.pop(missing)
    with pytest.raises(ConfigError) as err:
        load_settings(real_env)
    assert missing in str(err.value)


def test_error_never_contains_secret_values(real_env):
    real_env.pop("ANTHROPIC_API_KEY")
    with pytest.raises(ConfigError) as err:
        load_settings(real_env)
    text = str(err.value)
    for value in ("dg_placeholder", "token_placeholder", "wh_placeholder", "az_placeholder"):
        assert value not in text


def test_secrets_not_in_repr(real_env):
    s = load_settings(real_env)
    text = repr(s)
    assert "sk_placeholder" not in text and "token_placeholder" not in text


def test_real_mode_requires_https(real_env):
    real_env["PUBLIC_BASE_URL"] = "http://voz.example.test"
    with pytest.raises(ConfigError, match="https"):
        load_settings(real_env)


@pytest.mark.parametrize(
    "provider,needs",
    [
        ("elevenlabs", {"ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"}),
        ("cartesia", {"CARTESIA_API_KEY", "CARTESIA_VOICE_ID"}),
    ],
)
def test_tts_provider_requires_its_own_keys(real_env, provider, needs):
    real_env["TTS_PROVIDER"] = provider
    with pytest.raises(ConfigError) as err:
        load_settings(real_env)
    for name in needs:
        assert name in str(err.value)


def test_deepgram_tts_reuses_deepgram_key(real_env):
    real_env["TTS_PROVIDER"] = "deepgram"
    s = load_settings(real_env)
    assert missing_for_real(s) == []


def test_agent_profile_must_be_v5():
    with pytest.raises(ConfigError, match="MIDDLEWARE_AGENT_PROFILE"):
        load_settings({"MIDDLEWARE_AGENT_PROFILE": "v4"})


def test_overflow_dial_needs_number():
    with pytest.raises(ConfigError, match="FALLBACK_DIAL_NUMBER"):
        load_settings({"OVERFLOW_ACTION": "dial"})


def test_overflow_defaults_to_dial_when_number_given():
    s = load_settings({"FALLBACK_DIAL_NUMBER": "+34900000000"})
    assert s.overflow_action == "dial"


def test_fallback_number_must_be_e164():
    with pytest.raises(ConfigError, match="E.164"):
        load_settings({"FALLBACK_DIAL_NUMBER": "600000000"})


def test_bad_values_are_rejected():
    with pytest.raises(ConfigError):
        load_settings({"MAX_CONCURRENT_CALLS": "0"})
    with pytest.raises(ConfigError):
        load_settings({"TTS_PROVIDER": "piper"})
    with pytest.raises(ConfigError):
        load_settings({"PROMPT_STRATEGY": "otra"})
    with pytest.raises(ConfigError):
        load_settings({"VOICE_AGENT_ENABLED": "quizas"})


def test_silence_hangup_must_exceed_two_prompts():
    with pytest.raises(ConfigError, match="SILENCE_HANGUP_S"):
        load_settings({"SILENCE_PROMPT_S": "10", "SILENCE_HANGUP_S": "15"})


def test_keyterms_from_env():
    s = load_settings({"DEEPGRAM_KEYTERMS": "Chimac, degradado ,  barba"})
    assert s.deepgram_keyterms == ("Chimac", "degradado", "barba")


def test_env_example_has_only_placeholders_and_loads_offline():
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / ".env.example"
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    secret_keys = [k for k in env if k.endswith(("_KEY", "_TOKEN", "_SECRET"))]
    assert secret_keys
    for key in secret_keys:
        assert env[key] == "" or env[key].startswith("<"), key
    s = load_settings(env)
    assert s.mode == "offline" and s.enabled is False
    # todas las variables del ejemplo las lee config.py
    import inspect

    import voice_agent.config as config_module

    source = inspect.getsource(config_module)
    for key in env:
        assert f'"{key}"' in source, key
