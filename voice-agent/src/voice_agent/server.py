"""Servidor HTTP/WebSocket del agente de voz.

- ``POST /voice/twilio/incoming``: Twilio avisa de una llamada; contestamos TwiML.
- ``WS /voice/twilio/ws``: audio de la llamada (Twilio Media Streams).
- ``GET /voice/health``: estado, sin secretos.

Un solo proceso (el límite de llamadas se cuenta en memoria).
"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import parse_qsl

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, Response
from starlette.websockets import WebSocketDisconnect

from voice_agent import __version__
from voice_agent.calllog import purge_old_logs, server_event
from voice_agent.config import ConfigError, Settings, load_settings
from voice_agent.middleware_client import MiddlewareAPI, MiddlewareClient
from voice_agent.twilio_http import (
    STREAM_TOKEN_PARAM,
    CallSlots,
    connect_twiml,
    overflow_twiml,
    valid_twilio_signature,
)

CallRunner = Callable[..., Awaitable[None]]
START_TIMEOUT_S = 5.0
XML = "application/xml"


async def read_stream_start(websocket: WebSocket, timeout: float = START_TIMEOUT_S) -> dict[str, Any] | None:
    """Lee los primeros mensajes de Twilio hasta ``start``. None si no llega a tiempo."""

    async def _read() -> dict[str, Any] | None:
        for _ in range(5):
            raw = await websocket.receive_text()
            message = json.loads(raw)
            if not isinstance(message, dict):
                return None  # JSON válido pero no es un objeto: no es Twilio
            if message.get("event") == "start":
                return message if isinstance(message.get("start"), dict) else None
        return None

    try:
        return await asyncio.wait_for(_read(), timeout=timeout)
    except (TimeoutError, WebSocketDisconnect, ValueError, KeyError, TypeError, RuntimeError):
        return None


def _default_runner() -> CallRunner:
    from voice_agent.pipeline import run_call  # importa Pipecat solo si hace falta

    return run_call


def create_app(
    settings: Settings,
    middleware: MiddlewareAPI | None = None,
    call_runner: CallRunner | None = None,
) -> FastAPI:
    slots = CallSlots(settings.max_concurrent_calls)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        owned = False
        if app.state.middleware is None and settings.is_real:
            owned = True
            app.state.middleware = MiddlewareClient(
                base_url=settings.middleware_base_url,
                webhook_secret=settings.middleware_webhook_secret,
                booking_secret=settings.middleware_booking_secret,
                agent_profile=settings.middleware_agent_profile,
                availability_timeout_s=settings.middleware_availability_timeout_s,
                book_timeout_s=settings.middleware_book_timeout_s,
            )
        if settings.is_real:
            try:
                purge_old_logs(settings.call_log_dir, settings.call_log_retention_days)
            except OSError:
                pass
        yield
        if owned and app.state.middleware is not None:
            await app.state.middleware.aclose()

    app = FastAPI(title="Demo Salon voice agent", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.slots = slots
    app.state.middleware = middleware
    app.state.call_runner = call_runner

    @app.get("/voice/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "version": __version__,
                "mode": settings.mode,
                "enabled": settings.enabled,
                "active_calls": slots.active,
                "max_concurrent_calls": settings.max_concurrent_calls,
                "prompt_strategy": settings.prompt_strategy,
                "tts_provider": settings.tts_provider,
            }
        )

    @app.post("/voice/twilio/incoming")
    async def incoming(request: Request) -> Response:
        if not settings.is_real:
            return JSONResponse({"error": "modo offline: no se atienden llamadas"}, status_code=503)
        body = (await request.body()).decode("utf-8", errors="replace")
        params = dict(parse_qsl(body, keep_blank_values=True))
        signature = request.headers.get("X-Twilio-Signature")
        if not valid_twilio_signature(settings.twilio_auth_token, settings.incoming_url, params, signature):
            server_event(settings.call_log_dir, "firma_rechazada")
            return Response(status_code=403)
        if params.get("AccountSid") != settings.twilio_account_sid:
            server_event(settings.call_log_dir, "cuenta_rechazada")
            return Response(status_code=403)

        call_sid = params.get("CallSid", "")
        if not settings.enabled or not call_sid:
            server_event(settings.call_log_dir, f"desviada_apagado_{settings.overflow_action}")
            return Response(overflow_twiml(settings.overflow_action, settings.fallback_dial_number), media_type=XML)
        token = slots.reserve(call_sid)
        if token is None:
            server_event(settings.call_log_dir, f"desviada_desborde_{settings.overflow_action}")
            return Response(overflow_twiml(settings.overflow_action, settings.fallback_dial_number), media_type=XML)
        server_event(settings.call_log_dir, "aceptada")
        return Response(connect_twiml(settings.websocket_url, token), media_type=XML)

    @app.websocket("/voice/twilio/ws")
    async def media_stream(websocket: WebSocket) -> None:
        await websocket.accept()
        start = await read_stream_start(websocket)
        info = start["start"] if start is not None else {}
        call_sid = str(info.get("callSid") or "")
        stream_sid = str(info.get("streamSid") or (start or {}).get("streamSid") or "")
        custom = info.get("customParameters")
        token = custom.get(STREAM_TOKEN_PARAM) if isinstance(custom, dict) else None
        if not isinstance(token, str):
            token = None
        allowed = (
            settings.is_real
            and settings.enabled
            and call_sid
            and stream_sid
            and info.get("accountSid") == settings.twilio_account_sid
            and slots.activate(call_sid, token)
        )
        if not allowed:
            if settings.is_real:
                server_event(settings.call_log_dir, "ws_rechazado")
            await websocket.close(code=1008)
            return
        runner = app.state.call_runner or _default_runner()
        try:
            await runner(
                websocket,
                call_sid=call_sid,
                stream_sid=stream_sid,
                settings=settings,
                middleware=app.state.middleware,
            )
        finally:
            slots.release(call_sid)

    return app


def main() -> None:
    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"voice-agent no arranca: {exc}", file=sys.stderr)
        sys.exit(2)
    from voice_agent.logging_setup import configure_logging

    configure_logging(settings.log_level)
    import uvicorn

    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        workers=1,
        access_log=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
