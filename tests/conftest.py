"""A fake Akamai Inference endpoint, so the tests need no key and no network.

The fake speaks just enough of the OpenAI chat API: a model list, the output
limit error, and a streamed reply chosen by the model id.
"""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from server import akamai, config, evals, sites
from server.app import create_app

calls: dict[str, int] = {}  # requests seen per model, reset for each test

PAGE = "<!doctype html><html><body><h1>Hello</h1><script>document.title='ok'</script></body></html>"


def reply_for(model: str, body: dict) -> dict:
    """What each fake model says. Returns content, reasoning and finish_reason."""
    user = next(m["content"] for m in reversed(body["messages"]) if m["role"] == "user")
    system = next((m["content"] for m in body["messages"] if m["role"] == "system"), "")
    if "HTML document" in system:
        if model == "fenced":
            return {"content": f"Here you go:\n```html\n{PAGE}\n```\nEnjoy!"}
        if model == "short":
            done = any(m["role"] == "assistant" for m in body["messages"])
            return {"content": PAGE[38:] if done else PAGE[:38], "finish_reason": "stop" if done else "length"}
        return {"content": PAGE}
    if model == "thinker":
        return {"reasoning": "Let me think.", "content": "positive"}
    if model == "wrong":
        return {"content": "I cannot say."}
    if "sentiment" in system.lower():
        return {"content": "Positive." if "love" in user.lower() or "great" in user.lower() else "negative"}
    return {"content": "391"}


def handler(request: httpx.Request) -> httpx.Response:
    if request.headers.get("authorization") != "Bearer test-key":
        return httpx.Response(401, json={"error": {"message": "bad key"}})
    if request.url.path.endswith("/models"):
        ids = ["alpha", "wrong", "thinker", "fenced", "short", "broken", "limited", "test-embedding"]
        return httpx.Response(200, json={"data": [
            {"id": i, "object": "model", **({"max_output_tokens": 4096} if i == "alpha" else {})}
            for i in ids
        ]})
    body = json.loads(request.content)
    calls[body["model"]] = calls.get(body["model"], 0) + 1
    if body["model"] == "short" and body["max_tokens"] > 4096:
        return httpx.Response(400, json={"error": {"message": f"Max output tokens requested ({body['max_tokens']}) exceeds model limit (4096)."}})
    if body["model"] == "limited" and calls["limited"] == 1:
        return httpx.Response(429, json={"error": {"message": "Rate limit reached for requests."}}, headers={"retry-after": "0.05"})
    if body["model"] == "broken":
        return httpx.Response(400, json={"error": {"message": "The model is unavailable."}})
    reply = reply_for(body["model"], body)
    chunks = []
    if reply.get("reasoning"):
        chunks.append({"choices": [{"delta": {"reasoning": reply["reasoning"]}}]})
    text = reply.get("content", "")
    for i in range(0, len(text), 7):
        chunks.append({"choices": [{"delta": {"content": text[i:i + 7]}}]})
    chunks.append({"choices": [{"delta": {}, "finish_reason": reply.get("finish_reason", "stop")}]})
    usage = {"prompt_tokens": 12, "completion_tokens": max(1, len(text) // 4)}
    if body["model"] == "short":
        usage["completion_tokens_details"] = {"reasoning_tokens": 2}
    chunks.append({"choices": [], "usage": usage})
    stream = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return httpx.Response(200, content=stream, headers={"content-type": "text/event-stream"})


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "API_KEY", "test-key")
    monkeypatch.setattr(config, "BASE_URL", "https://fake.test/v1")
    monkeypatch.setattr(config, "DATA", tmp_path)
    monkeypatch.setattr(akamai, "_models", None)
    monkeypatch.setattr(akamai, "_cooldown_until", 0.0)
    calls.clear()
    evals.RUNS.clear()
    sites.BUILDS.clear()
    app = create_app(transport=httpx.MockTransport(handler))
    with TestClient(app, base_url="http://localhost") as test_client:
        yield test_client
