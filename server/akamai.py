"""The only module that talks to Akamai Inference.

The endpoint speaks the OpenAI chat API. Every request here streams, so time
to first token and tokens per second mean the same thing for every model.
Token counts come from the endpoint's `usage` block. Nothing is estimated.
"""

import asyncio
import json
import math
import time
from email.utils import parsedate_to_datetime

import httpx
from pydantic import BaseModel, Field, ValidationError

from . import config

# Shared client. app.py opens it at startup and closes it at shutdown.
client: httpx.AsyncClient | None = None

_models: list[dict] | None = None

# After a 429, no request in complete() starts before this time (time.monotonic()).
_cooldown_until = 0.0


def rate_limit_wait() -> float:
    """Seconds left before requests resume after the endpoint said to slow down."""
    return max(0.0, _cooldown_until - time.monotonic())


class EndpointError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class _Model(BaseModel):
    id: str = Field(min_length=1)
    max_output_tokens: int | None = Field(None, gt=0)


class _Catalog(BaseModel):
    data: list[_Model]


class _Delta(BaseModel):
    content: str | None = None
    reasoning: str | None = None
    reasoning_content: str | None = None
    tool_calls: object = None  # Preserve malformed native calls for the eval's format score.


class _Choice(BaseModel):
    delta: _Delta | None = None
    finish_reason: str | None = None


class _TokenDetails(BaseModel):
    reasoning_tokens: int | None = None


class _Usage(BaseModel):
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    completion_tokens_details: _TokenDetails | None = None


class _Chunk(BaseModel):
    choices: list[_Choice] | None = None
    usage: _Usage | None = None
    error: object = None


def _headers() -> dict:
    return {"Authorization": f"Bearer {config.API_KEY}"}


def _error_message(status: int, text: str) -> str:
    """Pull the readable message out of an error body."""
    try:
        error = json.loads(text).get("error")
        message = error.get("message") if isinstance(error, dict) else error
        if isinstance(message, str) and message.strip():
            text = message
    except (ValueError, AttributeError):
        pass
    if status == 401:
        return "The endpoint rejected the API key (401). Check the configured AKAMAI_API_KEY or AKAMAI_INFERENCE_API_KEY."
    if config.API_KEY:
        text = text.replace(config.API_KEY, "[redacted]")
    return (text or f"HTTP {status}").strip()[:500]


async def list_models(refresh: bool = False) -> list[dict]:
    """Every model the endpoint serves right now. Cached until refresh."""
    global _models
    if _models is not None and not refresh:
        return _models
    if not config.API_KEY:
        raise EndpointError(503, "Set AKAMAI_API_KEY in .env or export AKAMAI_INFERENCE_API_KEY before starting the server.")
    try:
        r = await client.get(f"{config.BASE_URL}/models", headers=_headers(), timeout=20)
    except httpx.HTTPError as exc:
        raise EndpointError(502, f"Could not reach {config.BASE_URL}: {type(exc).__name__}") from exc
    if r.status_code != 200:
        raise EndpointError(r.status_code, _error_message(r.status_code, r.text))
    try:
        catalog = _Catalog.model_validate_json(r.content, strict=True)
    except ValidationError as exc:
        raise EndpointError(502, "The endpoint returned an invalid model list.") from exc
    by_id = {m.id: m for m in catalog.data}
    models = []
    for model_id, model in sorted(by_id.items()):
        kind = "embedding" if "embed" in model_id else "chat"
        models.append({"id": model_id, "kind": kind, "max_output_tokens": model.max_output_tokens if kind == "chat" else None})
    _models = models
    return models


def request_body(model, messages, *, max_tokens=1024, temperature=None, top_p=None, reasoning="default"):
    """The JSON sent to /chat/completions.

    reasoning: "on" or "off" sets the chat template's thinking switch.
    "default" leaves the field out and each model does what it does by default.
    """
    body = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if temperature is not None:
        body["temperature"] = temperature
    if top_p is not None:
        body["top_p"] = top_p
    if reasoning in ("on", "off"):
        body["chat_template_kwargs"] = {"enable_thinking": reasoning == "on"}
    return body


async def stream_chat(body: dict):
    """Send one chat request and yield events as they arrive.

    {"type": "delta", "content": str, "reasoning": str}   zero or more
    {"type": "done", ...}                                  once, with timing and usage
    {"type": "error", "status": int, "message": str}       instead of done
    """
    started = time.perf_counter()
    first = None  # when the first token of any kind arrived
    usage, finish = None, None
    done = False
    try:
        async with client.stream(
            "POST", f"{config.BASE_URL}/chat/completions", headers=_headers(), json=body
        ) as r:
            if r.status_code != 200:
                text = (await r.aread()).decode(errors="replace")
                yield {
                    "type": "error",
                    "status": r.status_code,
                    "message": _error_message(r.status_code, text),
                    "retry_after": r.headers.get("retry-after"),
                }
                return
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    done = True
                    break
                chunk = _Chunk.model_validate_json(data, strict=True)
                if chunk.error is not None:
                    yield {"type": "error", "status": 502, "message": _error_message(502, data)}
                    return
                if chunk.choices is None and chunk.usage is None:
                    yield {"type": "error", "status": 502, "message": "The endpoint returned an invalid stream event."}
                    return
                usage = chunk.usage or usage
                for choice in chunk.choices or []:
                    finish = choice.finish_reason or finish
                    if choice.delta is None:
                        continue
                    content = choice.delta.content or ""
                    reasoning = choice.delta.reasoning or choice.delta.reasoning_content or ""
                    tools = choice.delta.tool_calls
                    if "tools" in body and tools is not None and tools != []:
                        if first is None:
                            first = time.perf_counter()
                        yield {"type": "tool_delta", "tool_calls": tools}
                    if content or reasoning:
                        if first is None:
                            first = time.perf_counter()
                        yield {"type": "delta", "content": content, "reasoning": reasoning}
    except ValidationError:
        yield {"type": "error", "status": 502, "message": "The endpoint returned an invalid stream event."}
        return
    except httpx.HTTPError as exc:
        yield {"type": "error", "status": 502, "message": f"Connection to the endpoint failed: {type(exc).__name__}"}
        return

    if not done and not finish:
        yield {"type": "error", "status": 502, "message": "The endpoint closed the stream before finishing the reply."}
        return
    ended = time.perf_counter()
    usage = usage or _Usage()
    completion = usage.completion_tokens
    decode = ended - (first or ended)
    yield {
        "type": "done",
        "finish_reason": finish,
        "ttft_ms": round((first - started) * 1000) if first else None,
        "total_ms": round((ended - started) * 1000),
        "prompt_tokens": usage.prompt_tokens,
        "completion_tokens": completion,
        "reasoning_tokens": usage.completion_tokens_details.reasoning_tokens if usage.completion_tokens_details else None,
        # Tokens per second while the model was writing, not counting the wait for the first token.
        "tokens_per_second": round(completion / decode, 1) if completion and decode > 0.05 else None,
    }


def _retry_delay(retry_after: str | None, attempt: int) -> float:
    if retry_after:
        try:
            seconds = float(retry_after)
        except ValueError:
            try:
                seconds = parsedate_to_datetime(retry_after).timestamp() - time.time()
            except (ValueError, TypeError, OverflowError, OSError):
                seconds = -1
        if math.isfinite(seconds) and seconds >= 0:
            return seconds
    return min(2 ** (attempt + 1), 30)


class _ToolStream:
    """Collect interleaved OpenAI deltas by tool index without repairing malformed calls."""
    def __init__(self):
        self.calls = {}
        self.errors = []

    def add(self, fragments):
        if not isinstance(fragments, list):
            self.errors.append("tool_calls must be an array.")
            return
        for part in fragments:
            if not isinstance(part, dict):
                self.errors.append("A tool call fragment is not an object.")
                continue
            index = part.get("index")
            if type(index) is not int or index < 0:
                self.errors.append("A streamed tool call has no valid index.")
                index = len(self.calls)
            call = self.calls.setdefault(index, {"id": "", "type": "", "function": {"name": "", "arguments": ""}})
            for key in ("id", "type"):
                value = part.get(key)
                if value is None:
                    continue
                if not isinstance(value, str) or (call[key] and call[key] != value):
                    self.errors.append(f"Inconsistent tool call {key}.")
                else:
                    call[key] = value
            function = part.get("function")
            if function is None:
                continue
            if not isinstance(function, dict):
                self.errors.append("The function field is not an object.")
                continue
            for key in ("name", "arguments"):
                value = function.get(key)
                if value is None:
                    continue
                if isinstance(value, str):
                    call["function"][key] += value
                else:
                    self.errors.append(f"Function {key} must be a string.")
                    call["function"][key] += json.dumps(value, ensure_ascii=False)

    def result(self):
        return {"tool_calls": [self.calls[i] for i in sorted(self.calls)], "tool_format_errors": self.errors}


async def complete(body: dict, on_delta=None, retries: int = 5) -> dict:
    """Run one request to the end and return the whole reply as a dict.

    Retries 429 and 5xx with backoff, but only if no token has arrived yet.
    A 429 pauses every caller of this function, not just the one that got it,
    so a batch slows down together instead of hammering the endpoint.
    The result always has "content" and "reasoning". On failure it has "error".
    """
    global _cooldown_until
    failure = {"status": 502, "message": "No reply"}
    for attempt in range(retries + 1):
        while (remaining := rate_limit_wait()) > 0:
            await asyncio.sleep(remaining)
        content, reasoning = [], []
        tools = _ToolStream() if "tools" in body else None
        async for event in stream_chat(body):
            if event["type"] == "delta":
                content.append(event["content"])
                reasoning.append(event["reasoning"])
                if on_delta:
                    on_delta(event)
            elif event["type"] == "tool_delta":
                tools.add(event["tool_calls"])
            elif event["type"] == "done":
                return {**event, "content": "".join(content), "reasoning": "".join(reasoning),
                        **(tools.result() if tools is not None else {})}
            else:
                failure = event  # stream_chat ends after an error event
        wait = _retry_delay(failure.get("retry_after"), attempt)
        if failure["status"] == 429:
            _cooldown_until = max(_cooldown_until, time.monotonic() + wait)
        retryable = failure["status"] == 429 or failure["status"] >= 500
        if not retryable or content or reasoning or (tools and (tools.calls or tools.errors)) or attempt == retries:
            break
        if failure["status"] != 429:
            await asyncio.sleep(wait)
    return {
        "error": failure["message"],
        "status": failure["status"],
        "content": "".join(content),
        "reasoning": "".join(reasoning),
        **(tools.result() if tools is not None else {}),
    }
