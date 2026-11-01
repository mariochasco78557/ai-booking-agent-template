# voice-agent (Python)

Self-hosted phone voice agent: Twilio Media Streams -> Pipecat pipeline
(Deepgram STT, Claude, TTS) -> the same booking middleware tools the WhatsApp
brain uses. Turn detection, call logging, offline evaluation scenarios
(`src/voice_agent/eval*.py`) and a contract test against the middleware
(`tests/test_middleware_contract.py`).

```bash
cd voice-agent
uv sync            # Python >= 3.12, installs pipecat and friends
uv run pytest
```

All credentials (Twilio, Deepgram, Anthropic, middleware secret) come from
environment variables read in `src/voice_agent/config.py`; none are in the repo.
