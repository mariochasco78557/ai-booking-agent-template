"""Claude Haiku 4.5 con el prompt repartido y caché de prompt ((internal doc, not included in the template) §1.2).

Sobre ``AnthropicLLMService`` de Pipecat 1.12.0 cambia solo cómo se arma cada petición:

1. ``system`` pasa a ser una lista de bloques (núcleo y, en modo ``nodos``, el paso),
   cada uno con ``cache_control``. Pipecat ya marca los dos últimos mensajes del
   cliente, así que hay como mucho 4 puntos de caché (el máximo de la API).
2. Al FINAL del último mensaje se añade la guía del turno (paso, estado y fecha).
   Va detrás del último punto de caché y no se guarda en el contexto, así que
   no rompe la caché del turno siguiente.
3. Si el primer mensaje es del asistente (el saludo), se antepone «[llamada conectada]»
   como mensaje del cliente: la API exige empezar por el cliente.

Además: guarda el texto que el modelo va generando en el turno (para G8) y avisa
al pipeline cuando la API de Anthropic falla.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from pipecat.frames.frames import Frame, LLMFullResponseStartFrame, LLMTextFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.anthropic.llm import AnthropicLLMService

from voice_agent.request_shape import CONNECTED_MARK, count_cache_breakpoints, shape_request

__all__ = ["CONNECTED_MARK", "DemoSalonAnthropicLLMService", "count_cache_breakpoints", "shape_request"]

class DemoSalonAnthropicLLMService(AnthropicLLMService):
    """AnthropicLLMService con prompt por pasos, guía del turno y avisos de fallo."""

    def __init__(
        self,
        *,
        system_provider: Callable[[], list[str]],
        guidance_provider: Callable[[], str],
        on_llm_failure: Callable[[str], Awaitable[None]] | None = None,
        **kwargs: Any,
    ):
        super().__init__(**kwargs)
        self._system_provider = system_provider
        self._guidance_provider = guidance_provider
        self._on_llm_failure = on_llm_failure
        self.current_response_text = ""

    def _get_llm_invocation_params(self, context):  # type: ignore[override]
        params = super()._get_llm_invocation_params(context)
        return shape_request(dict(params), self._system_provider(), self._guidance_provider())

    async def push_frame(self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM):
        if isinstance(frame, LLMFullResponseStartFrame):
            self.current_response_text = ""
        elif isinstance(frame, LLMTextFrame):
            self.current_response_text += frame.text
        await super().push_frame(frame, direction)

    async def push_error(self, error_msg: str, exception: Exception | None = None, *args: Any, **kwargs: Any):
        await super().push_error(error_msg, exception, *args, **kwargs)
        if self._on_llm_failure is not None:
            await self._on_llm_failure(type(exception).__name__ if exception else "error")
