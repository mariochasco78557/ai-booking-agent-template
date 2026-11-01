from __future__ import annotations

import json
import os
import time

from voice_agent.calllog import PHONE_MASK, CallLog, purge_old_logs, redact_phones


def test_phone_redaction_digits_and_words():
    assert PHONE_MASK in redact_phones("mi teléfono es 600 000 123")
    assert "600" not in redact_phones("mi teléfono es 600000123")
    spoken = "teléfono seis, cero, cero; cero, cero, cero; uno, dos, tres."
    assert "seis" not in redact_phones(spoken)
    # horas y números cortos se quedan
    assert redact_phones("a las 10:30, opción 2") == "a las 10:30, opción 2"
    assert redact_phones("las diez y media") == "las diez y media"


def test_call_log_writes_jsonl_without_phones(tmp_path):
    log = CallLog(str(tmp_path), "tw_CAtest00000001")
    log.user("Me llamo Prueba, 600000123")
    log.bot("teléfono seis, cero, cero; cero, cero, cero; uno, dos, tres")
    log.llm_usage(100, 20, 5000, 0)
    log.end("completed")
    lines = [json.loads(l) for l in log.path.read_text(encoding="utf-8").splitlines()]
    assert [l["kind"] for l in lines] == ["user", "bot", "llm_usage", "end"]
    assert "600000123" not in log.path.read_text(encoding="utf-8")
    assert lines[-1]["usage"]["cache_read_input_tokens"] == 5000


def test_no_directory_means_no_file():
    log = CallLog(None, "tw_x0000000")
    log.user("hola")
    assert log.path is None


def test_retention_purges_old_files(tmp_path):
    old = tmp_path / "old.jsonl"
    new = tmp_path / "new.jsonl"
    other = tmp_path / "keep.txt"
    for f in (old, new, other):
        f.write_text("{}")
    past = time.time() - 40 * 86400
    os.utime(old, (past, past))
    os.utime(other, (past, past))
    assert purge_old_logs(tmp_path, 30) == 1
    assert not old.exists() and new.exists() and other.exists()
