import asyncio
import json
import os
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from server import akamai, config


@pytest.mark.parametrize(("short", "official", "expected"), [
    (" project-key ", "dashboard-key", "project-key"),
    ("paste_your_key_here", " dashboard-key ", "dashboard-key"),
    (" ", "dashboard-key", "dashboard-key"),
    (None, "dashboard-key", "dashboard-key"),
    (None, "paste_your_key_here", ""),
    (None, None, ""),
])
def test_api_key_precedence(monkeypatch, short, official, expected):
    for name, value in (("AKAMAI_API_KEY", short), ("AKAMAI_INFERENCE_API_KEY", official)):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    assert config._api_key() == expected


@pytest.mark.parametrize("value", [
    "https://api.akamai-inference.com/v1", "https://models.example.test:8443/api/v1/",
    "http://localhost:8800/v1", "http://127.0.0.1:8800/v1", "http://[::1]:8800/v1",
])
def test_inference_endpoint_accepts_remote_tls_and_local_http(value):
    assert config._base_url(value) == value.rstrip("/")


@pytest.mark.parametrize("value", [
    "http://models.example.test/v1", "file:///secret", "https://", "https://localhost:99999/v1",
    "https://account:private-value@example.test/v1", "https://example.test/?key=private-value",
    "https://example.test/#private-value", "http://localhost.example.test/v1",
])
def test_inference_endpoint_rejects_invalid_urls_without_echoing_secrets(value):
    with pytest.raises(ValueError, match="AKAMAI_BASE_URL") as exc:
        config._base_url(value)
    assert "private-value" not in str(exc.value)


def test_development_server_keeps_both_inference_keys_out_of_frontend_process(monkeypatch):
    from server import __main__ as launcher

    for key in config.API_KEY_VARIABLES:
        monkeypatch.setenv(key, "test-key")
    child = Mock(pid=1)
    child.poll.return_value = 0
    launch = Mock(return_value=child)
    monkeypatch.setattr(launcher.subprocess, "Popen", launch)
    monkeypatch.setattr(launcher.signal, "signal", Mock())
    monkeypatch.setattr(launcher.os, "killpg", Mock())
    assert launcher.develop() == 0
    backend, frontend = launch.call_args_list
    assert "env" not in backend.kwargs and all(os.environ[k] == "test-key" for k in config.API_KEY_VARIABLES)
    assert frontend.args[0] == ["npm", "run", "dev"]
    assert frontend.kwargs["env"]["PORT"] == str(config.PORT)
    assert not set(config.API_KEY_VARIABLES).intersection(frontend.kwargs["env"])


def stream(*chunks):
    return "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)


def collect(response_text, monkeypatch):
    async def run():
        transport = httpx.MockTransport(lambda _: httpx.Response(200, text=response_text))
        async with httpx.AsyncClient(transport=transport) as endpoint:
            monkeypatch.setattr(akamai, "client", endpoint)
            return [event async for event in akamai.stream_chat({})]

    return asyncio.run(run())


@pytest.mark.parametrize("suffix", ["", "data: {\n\n", stream(None), stream({"choices": [{"delta": {"content": []}}]})])
def test_incomplete_or_invalid_stream_fails_after_preserving_text(monkeypatch, suffix):
    partial = stream({"choices": [{"delta": {"content": "partial"}}]})
    events = collect(partial + suffix, monkeypatch)
    assert [event["type"] for event in events] == ["delta", "error"]
    assert events[0]["content"] == "partial" and events[-1]["status"] == 502


def test_non_streaming_success_response_is_an_error(monkeypatch):
    events = collect("<html>Gateway is starting up</html>", monkeypatch)
    assert len(events) == 1 and events[0]["type"] == "error"


def test_final_choice_is_valid_even_without_done_marker(monkeypatch):
    events = collect(stream({"choices": [{"finish_reason": "stop", "delta": {"content": "answer"}}]}), monkeypatch)
    assert [event["type"] for event in events] == ["delta", "done"]
    assert events[-1]["finish_reason"] == "stop"


@pytest.mark.parametrize("payload", ["html", "{}", '{"data":[{"name":"alpha"}]}'])
def test_invalid_model_list_reports_gateway_error(monkeypatch, payload):
    async def run():
        transport = httpx.MockTransport(lambda _: httpx.Response(200, text=payload))
        async with httpx.AsyncClient(transport=transport) as endpoint:
            monkeypatch.setattr(akamai.config, "API_KEY", "test")
            monkeypatch.setattr(akamai, "client", endpoint)
            with pytest.raises(akamai.EndpointError) as exc:
                await akamai.list_models(refresh=True)
            assert exc.value.status == 502

    asyncio.run(run())


def test_cooldown_is_shared_and_rechecked_after_waking(monkeypatch):
    now = 0.0
    waits = []

    async def sleep(delay):
        nonlocal now
        waits.append(delay)
        now += delay
        if len(waits) == 1:
            # A second in-flight request extended the cooldown as we slept.
            akamai._cooldown_until = 7.0

    async def limited(_body):
        yield {"type": "error", "status": 429, "retry_after": "3", "message": "Try again"}

    monkeypatch.setattr(akamai, "time", SimpleNamespace(monotonic=lambda: now))
    monkeypatch.setattr(akamai, "asyncio", SimpleNamespace(sleep=sleep))
    monkeypatch.setattr(akamai, "_cooldown_until", 0.0)
    monkeypatch.setattr(akamai, "stream_chat", limited)
    for _ in range(2):
        assert asyncio.run(akamai.complete({}, retries=0))["status"] == 429
    assert waits == [3.0, 4.0]
