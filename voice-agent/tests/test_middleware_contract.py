"""El cliente habla EXACTAMENTE el contrato de TOOL_SCHEMAS_BALANCED_V5.json."""

from __future__ import annotations

import json

import httpx
import pytest

from voice_agent.middleware_client import (
    ACTION_FIELDS,
    AGENDA_UNAVAILABLE_MESSAGE,
    BOOK_FIELDS,
    BOOKING_UNCERTAIN_MESSAGE,
    MiddlewareClient,
    build_availability_body,
    build_book_body,
)

CONV = "tw_CA0123456789abcdef0123456789abcdef"


def _tool(schema: dict, name: str) -> dict:
    return next(t for t in schema["tools"] if t["name"] == name)


def test_paths_and_headers_match_schema(v5_schema):
    from voice_agent import middleware_client as mc

    avail = _tool(v5_schema, "booking_availability_balanced_v2")
    book = _tool(v5_schema, "booking_create_booking_balanced_v2")
    assert avail["path"] == mc.AVAILABILITY_PATH and avail["method"] == "POST"
    assert book["path"] == mc.BOOK_PATH and book["method"] == "POST"
    assert v5_schema["authHeader"]["name"] == mc.WEBHOOK_SECRET_HEADER
    assert v5_schema["bookingAuthHeader"]["name"] == mc.BOOKING_SECRET_HEADER
    assert set(avail["headers"]) == {"Content-Type", mc.WEBHOOK_SECRET_HEADER}
    assert set(book["headers"]) == {
        "Content-Type",
        mc.WEBHOOK_SECRET_HEADER,
        mc.BOOKING_SECRET_HEADER,
    }


def test_actions_match_schema_enum(v5_schema):
    avail = _tool(v5_schema, "booking_availability_balanced_v2")
    from voice_agent.middleware_client import ACTIONS

    enum = avail["parameters"]["properties"]["action"]["enum"]
    assert list(ACTIONS) == enum
    assert set(ACTION_FIELDS) == set(enum)


def test_every_field_we_can_send_exists_in_schema(v5_schema):
    avail = _tool(v5_schema, "booking_availability_balanced_v2")["parameters"]
    book = _tool(v5_schema, "booking_create_booking_balanced_v2")["parameters"]
    avail_props = set(avail["properties"])
    for fields in ACTION_FIELDS.values():
        assert set(fields) <= avail_props
    assert set(BOOK_FIELDS) | {"conversation_id", "agent_profile"} == set(book["properties"])
    assert set(book["required"]) == set(book["properties"])


def test_agent_profile_constant_matches(v5_schema):
    for tool in v5_schema["tools"]:
        prop = tool["parameters"]["properties"]["agent_profile"]
        assert prop["constant_value"] == "v5"


@pytest.mark.parametrize(
    "args,expected_keys",
    [
        (
            {"action": "discover", "service_id": 1, "date": "2026-10-07", "time_period": "afternoon",
             "preferred_time": "16:00", "option_index": 2},
            {"service_id", "date", "time_period", "preferred_time"},
        ),
        (
            {"action": "more", "service_id": 1, "date": "2026-10-07", "employee_id": 1,
             "preferred_time": "10:00", "option_index": 1, "preferred_employee_id": 1},
            set(),
        ),
        ({"action": "lock", "option_index": 2, "date": "2026-10-07"}, {"option_index"}),
        (
            {"action": "scan", "service_id": 2, "date_from": "2026-10-07", "days": 7,
             "after_time": "18:00"},
            {"service_id", "date_from", "days", "after_time"},
        ),
    ],
)
def test_availability_body_respects_v5_and_v6(v5_schema, args, expected_keys):
    body = build_availability_body(CONV, "v5", args)
    assert body["conversation_id"] == CONV
    assert body["agent_profile"] == "v5"
    assert body["action"] == args["action"]
    assert set(body) - {"conversation_id", "agent_profile", "action"} == expected_keys
    props = set(_tool(v5_schema, "booking_availability_balanced_v2")["parameters"]["properties"])
    assert set(body) <= props
    required = _tool(v5_schema, "booking_availability_balanced_v2")["parameters"]["required"]
    assert set(required) <= set(body)


def test_book_body_has_exact_required_fields(v5_schema):
    body = build_book_body(
        CONV,
        "v5",
        {
            "customer_name": "Prueba",
            "customer_surnames": "Uno Dos",
            "phone": "600 000 123",
            "slot_token": "tk1.x",
            "confirmed_by_customer": True,
        },
    )
    book = _tool(v5_schema, "booking_create_booking_balanced_v2")["parameters"]
    assert set(body) == set(book["required"])
    assert body["phone"] == "600000123"


def test_conversation_id_shape_accepted_by_middleware():
    # src/schemas/aiSchemas.ts: /^[A-Za-z0-9_-]+$/, 8..200
    import re

    assert re.fullmatch(r"[A-Za-z0-9_-]{8,200}", CONV)


def _client(handler) -> MiddlewareClient:
    return MiddlewareClient(
        base_url="http://middleware:3000",
        webhook_secret="wh-secret",
        booking_secret="bk-secret",
        transport=httpx.MockTransport(handler),
    )


async def test_availability_sends_read_secret_only():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"outcome": "options_available", "message": "m"})

    client = _client(handler)
    result = await client.availability(CONV, {"action": "discover", "service_id": 1})
    await client.aclose()
    assert seen["url"] == "http://middleware:3000/ai/voice/v2/availability"
    assert seen["headers"]["x-ai-webhook-secret"] == "wh-secret"
    assert "x-ai-booking-secret" not in seen["headers"]
    assert seen["headers"]["content-type"] == "application/json"
    assert seen["body"]["agent_profile"] == "v5"
    assert result.body["outcome"] == "options_available"
    assert result.meta.http_status == 200 and result.meta.transport_error is None


async def test_book_sends_both_secrets():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        return httpx.Response(200, json={"booked": True, "outcome": "confirmed"})

    client = _client(handler)
    await client.book(CONV, {"slot_token": "t", "confirmed_by_customer": True})
    await client.aclose()
    assert seen["url"].endswith("/ai/voice/v2/book")
    assert seen["headers"]["x-ai-webhook-secret"] == "wh-secret"
    assert seen["headers"]["x-ai-booking-secret"] == "bk-secret"


async def test_book_without_booking_secret_omits_header():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["headers"] = dict(request.headers)
        return httpx.Response(200, json={"booked": True, "outcome": "confirmed"})

    client = MiddlewareClient(
        base_url="http://m:3000", webhook_secret="w", transport=httpx.MockTransport(handler)
    )
    await client.book(CONV, {})
    await client.aclose()
    assert "x-ai-booking-secret" not in seen["headers"]


async def test_availability_network_failure_becomes_agenda_unavailable():
    def handler(request):
        raise httpx.ConnectError("down")

    client = _client(handler)
    result = await client.availability(CONV, {"action": "discover"})
    await client.aclose()
    assert result.body["outcome"] == "agenda_unavailable"
    assert result.body["message"] == AGENDA_UNAVAILABLE_MESSAGE
    assert result.meta.transport_error == "network"


async def test_availability_timeout_becomes_agenda_unavailable():
    def handler(request):
        raise httpx.ReadTimeout("slow")

    client = _client(handler)
    result = await client.availability(CONV, {"action": "lock", "option_index": 1})
    await client.aclose()
    assert result.body["outcome"] == "agenda_unavailable"
    assert result.meta.transport_error == "timeout"


@pytest.mark.parametrize("status", [401, 500, 502])
async def test_book_http_error_is_uncertain_never_confirmed(status):
    def handler(request):
        return httpx.Response(status, json={"success": False})

    client = _client(handler)
    result = await client.book(CONV, {"slot_token": "t", "confirmed_by_customer": True})
    await client.aclose()
    assert result.body["outcome"] == "uncertain"
    assert result.body["booked"] is False
    assert result.body["message"] == BOOKING_UNCERTAIN_MESSAGE
    assert result.meta.transport_error == f"http_{status}"


async def test_non_json_body_is_handled():
    def handler(request):
        return httpx.Response(200, content=b"<html>")

    client = _client(handler)
    result = await client.availability(CONV, {"action": "more"})
    await client.aclose()
    assert result.body["outcome"] == "agenda_unavailable"
    assert result.meta.transport_error == "invalid_json"


async def test_client_never_retries():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        raise httpx.ReadTimeout("slow")

    client = _client(handler)
    await client.book(CONV, {"slot_token": "t"})
    await client.aclose()
    assert calls["n"] == 1
