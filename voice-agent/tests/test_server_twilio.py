"""TwiML, firma de Twilio, límite de llamadas y WebSocket."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from voice_agent.config import load_settings
from voice_agent.server import create_app
from voice_agent.twilio_http import CallSlots, connect_twiml, overflow_twiml, valid_twilio_signature

ACCOUNT = "AC_placeholder"
AUTH = "token_placeholder"
URL = "https://voz.example.test/voice/twilio/incoming"


def twilio_signature(auth_token: str, url: str, params: dict[str, str]) -> str:
    """Algoritmo publicado por Twilio, escrito aparte para no fiarse solo del SDK."""
    data = url + "".join(k + params[k] for k in sorted(params))
    digest = hmac.new(auth_token.encode(), data.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def call_params(call_sid: str = "CA0001") -> dict[str, str]:
    return {"AccountSid": ACCOUNT, "CallSid": call_sid, "From": "+34600000000", "To": "+34900000000"}


class FakeRunner:
    def __init__(self):
        self.calls = []

    async def __call__(self, websocket, **kwargs):
        self.calls.append(kwargs)
        await websocket.close()


@pytest.fixture
def real_settings(real_env):
    return load_settings(real_env)


def post_call(client: TestClient, params: dict[str, str], signature: str | None = None):
    sig = signature if signature is not None else twilio_signature(AUTH, URL, params)
    return client.post(
        "/voice/twilio/incoming",
        content=urlencode(params),
        headers={"Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig},
    )


# ── piezas ─────────────────────────────────────────────────────────────────

def test_signature_matches_independent_algorithm():
    params = call_params()
    good = twilio_signature(AUTH, URL, params)
    assert valid_twilio_signature(AUTH, URL, params, good)
    assert not valid_twilio_signature(AUTH, URL, params, "AAAA")
    assert not valid_twilio_signature(AUTH, URL, {**params, "From": "+34611111111"}, good)
    assert not valid_twilio_signature(AUTH, "https://otro.example/voice/twilio/incoming", params, good)
    assert not valid_twilio_signature("", URL, params, good)
    assert not valid_twilio_signature(AUTH, URL, params, None)


def test_connect_twiml_shape():
    xml = connect_twiml("wss://voz.example.test/voice/twilio/ws", "tok123")
    assert "<Connect><Stream url=\"wss://voz.example.test/voice/twilio/ws\">" in xml
    assert '<Parameter name="token" value="tok123" />' in xml


def test_overflow_twiml():
    assert "<Dial>+34900000000</Dial>" in overflow_twiml("dial", "+34900000000")
    assert '<Reject reason="busy" />' in overflow_twiml("reject", "")


def test_slots_limit_release_and_expiry():
    now = [0.0]
    slots = CallSlots(3, pending_ttl_s=20, clock=lambda: now[0])
    tokens = [slots.reserve(f"CA{i}") for i in range(3)]
    assert all(tokens)
    assert slots.reserve("CA9") is None  # cuarta: desborda
    assert slots.reserve("CA0") == tokens[0]  # reintento de Twilio: misma ficha
    assert slots.activate("CA0", tokens[0])
    assert not slots.activate("CA0", tokens[0])  # un solo uso
    assert not slots.activate("CA1", "otra")
    slots.release("CA0")
    assert slots.reserve("CA9")
    now[0] = 30.0  # caducan las reservas sin WebSocket
    assert slots.in_use == 0


# ── servidor ───────────────────────────────────────────────────────────────

def test_health_offline_without_keys():
    with TestClient(create_app(load_settings({}))) as client:
        data = client.get("/voice/health").json()
    assert data["status"] == "ok" and data["mode"] == "offline" and data["enabled"] is False
    assert data["max_concurrent_calls"] == 3
    assert "token" not in json.dumps(data).lower()


def test_offline_mode_never_takes_calls():
    with TestClient(create_app(load_settings({}))) as client:
        assert client.post("/voice/twilio/incoming", content="CallSid=CA1").status_code == 503


def test_incoming_rejects_bad_signature(real_settings):
    with TestClient(create_app(real_settings, middleware=object())) as client:
        assert post_call(client, call_params(), signature="nope").status_code == 403
        assert post_call(client, call_params(), signature="").status_code == 403


def test_incoming_rejects_other_account(real_settings):
    with TestClient(create_app(real_settings, middleware=object())) as client:
        assert post_call(client, {**call_params(), "AccountSid": "ACotro"}).status_code == 403


def test_incoming_returns_stream_twiml(real_settings):
    with TestClient(create_app(real_settings, middleware=object())) as client:
        resp = post_call(client, call_params())
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/xml")
    assert '<Stream url="wss://voz.example.test/voice/twilio/ws">' in resp.text


def test_kill_switch_diverts_to_fallback(real_env):
    real_env.update(VOICE_AGENT_ENABLED="false", FALLBACK_DIAL_NUMBER="+34900000000")
    settings = load_settings(real_env)
    with TestClient(create_app(settings, middleware=object())) as client:
        resp = post_call(client, call_params())
    assert "<Dial>+34900000000</Dial>" in resp.text and "<Stream" not in resp.text


def test_overflow_after_max_calls(real_env):
    real_env.update(MAX_CONCURRENT_CALLS="2", FALLBACK_DIAL_NUMBER="+34900000000")
    settings = load_settings(real_env)
    with TestClient(create_app(settings, middleware=object())) as client:
        assert "<Stream" in post_call(client, call_params("CA1")).text
        assert "<Stream" in post_call(client, call_params("CA2")).text
        third = post_call(client, call_params("CA3")).text
    assert "<Dial>+34900000000</Dial>" in third


def test_overflow_reject_when_no_number(real_env):
    real_env.update(MAX_CONCURRENT_CALLS="1")
    settings = load_settings(real_env)
    with TestClient(create_app(settings, middleware=object())) as client:
        post_call(client, call_params("CA1"))
        assert "<Reject" in post_call(client, call_params("CA2")).text


def _token_from(twiml: str) -> str:
    return twiml.split('name="token" value="')[1].split('"')[0]


def _start_msg(call_sid: str, token: str | None, account: str = ACCOUNT) -> str:
    custom = {"token": token} if token is not None else {}
    return json.dumps({
        "event": "start",
        "streamSid": "MZ1",
        "start": {"accountSid": account, "callSid": call_sid, "streamSid": "MZ1", "customParameters": custom},
    })


def test_websocket_runs_call_with_valid_token_once(real_settings):
    runner = FakeRunner()
    app = create_app(real_settings, middleware=object(), call_runner=runner)
    with TestClient(app) as client:
        token = _token_from(post_call(client, call_params("CA7")).text)
        with client.websocket_connect("/voice/twilio/ws") as ws:
            ws.send_text(json.dumps({"event": "connected"}))
            ws.send_text(_start_msg("CA7", token))
            with pytest.raises(WebSocketDisconnect):
                ws.receive_text()
        assert runner.calls and runner.calls[0]["call_sid"] == "CA7" and runner.calls[0]["stream_sid"] == "MZ1"
        assert app.state.slots.in_use == 0  # liberada al terminar
        # la misma ficha no sirve dos veces
        with client.websocket_connect("/voice/twilio/ws") as ws:
            ws.send_text(_start_msg("CA7", token))
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_text()
        assert closed.value.code == 1008
    assert len(runner.calls) == 1


@pytest.mark.parametrize("token,account", [(None, ACCOUNT), ("falsa", ACCOUNT), ("REAL", "ACotro")])
def test_websocket_without_valid_token_never_opens_pipeline(real_settings, token, account):
    runner = FakeRunner()
    with TestClient(create_app(real_settings, middleware=object(), call_runner=runner)) as client:
        real_token = _token_from(post_call(client, call_params("CA8")).text)
        sent = real_token if token == "REAL" else token
        with client.websocket_connect("/voice/twilio/ws") as ws:
            ws.send_text(_start_msg("CA8", sent, account))
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_text()
        assert closed.value.code == 1008
    assert runner.calls == []
