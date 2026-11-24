import asyncio
import json

import httpx
import pytest

from server import akamai, evals


def spec(name):
    return {"type": "function", "function": {"name": name, "description": "Read a fixture value.", "parameters": {
        "type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"], "additionalProperties": False,
    }}}


TASK = {"id": "test_tools", "grader": "tool_calls", "system": "Use the available tools.",
        "tools": [spec("find_item"), spec("get_item")]}
FIRST = {"name": "find_item", "arguments": {"id": 1}}


def stream(*deltas, finish="tool_calls", tokens=7):
    chunks = [{"choices": [{"delta": delta}]} for delta in deltas]
    if finish is not None:
        chunks += [{"choices": [{"delta": {}, "finish_reason": finish}]}]
        chunks += [{"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": tokens,
                                             "completion_tokens_details": {"reasoning_tokens": 2}}}]
    return httpx.Response(200, text="".join(f"data: {json.dumps(c)}\n\n" for c in chunks))


def call(name="find_item", args='{"id":1}', ident="call_a", index=0):
    return {"tool_calls": [{"index": index, "id": ident, "type": "function", "function": {
        "name": name, "arguments": args,
    }}]}


def run_case(monkeypatch, expected, responses, task=TASK):
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        assert request.url.path.endswith("/chat/completions")
        return responses[len(requests) - 1]

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as endpoint:
            monkeypatch.setattr(akamai, "client", endpoint)
            monkeypatch.setattr(akamai, "_cooldown_until", 0.0)
            return await evals._run_one({"reasoning": "on"}, "test-model", task,
                                        {"id": "case", "input": "Look this up.", "expected": expected})

    return asyncio.run(run()), requests


def test_native_three_step_flow_replays_ids_observations_and_thinking(monkeypatch):
    second = {"name": "get_item", "arguments": {"id": 37}, "observation": {"status": "ready"}}
    case = {"steps": [{**FIRST, "observation": {"found": 37}}, second], "answer": ["ready"]}
    first = stream({"reasoning_content": "Think."}, call(name="find_", args='{"i'),
                   {"tool_calls": [{"index": 0, "function": {"name": "item", "arguments": 'd":1}'}}]})
    result, sent = run_case(monkeypatch, case, [
        first, stream(call("get_item", '{"id":37}', "call_b")), stream({"content": "Ready."}, finish="stop"),
    ])
    assert result["passed"], result
    assert result["tool_checks"] == {"selection": True, "arguments": True, "format": True}
    assert result["prompt_tokens"] == 36 and result["completion_tokens"] == 21 and result["reasoning_tokens"] == 6
    assert result["ttft_ms"] is not None and result["output"] == "Ready."
    assert len(sent) == 3 and all(b["tools"] == TASK["tools"] and b["tool_choice"] == "auto" for b in sent)
    assert all(b["stream"] and b["stream_options"]["include_usage"] and b["chat_template_kwargs"]["enable_thinking"] for b in sent)
    assert "found" not in json.dumps(sent[0]["messages"])
    assert sent[1]["messages"][-2]["reasoning_content"] == "Think."
    assert sent[1]["messages"][-2]["tool_calls"][0]["function"] == {"name": "find_item", "arguments": '{"id":1}'}
    for body, ident, observation in [(sent[1], "call_a", {"found": 37}), (sent[2], "call_b", {"status": "ready"})]:
        message = body["messages"][-1]
        assert message["role"] == "tool" and message["tool_call_id"] == ident
        assert json.loads(message["content"]) == observation


@pytest.mark.parametrize("delta, checks", [
    ({"content": '{"name":"find_item","arguments":{"id":1}}'}, (False, False, None)),
    (call(ident=""), (False, True, True)),
    (call(name="get_item"), (True, False, None)),
    (call(args='{"id":true}'), (True, True, False)),
    (call(args='{"id":1,"id":2}'), (False, True, None)),
    (call(args='[1]'), (False, True, None)),
    (call(args='{"id":NaN}'), (False, True, None)),
    (call(args='{"id":'), (False, True, None)),
    ({"tool_calls": "invalid envelope"}, (False, False, None)),
    ({"tool_calls": [*call()["tool_calls"], *call(index=1, ident="call_b")["tool_calls"]]}, (True, False, None)),
])
def test_native_format_selection_and_arguments_are_scored_independently(monkeypatch, delta, checks):
    result, _ = run_case(monkeypatch, {"steps": [FIRST]}, [stream(delta)])
    stage = result["tool_trace"][0]
    assert not result["passed"] and "error" not in result
    assert tuple(stage[key] for key in ("format", "selection", "arguments")) == checks
    assert result["notes"] and stage["notes"]


@pytest.mark.parametrize("reply, passed", [
    ("Which project ID should I use?", True), ("Please specify the project.", True),
    ("I used the first project in the region.", False), ("Please specify the region.", False),
    ("I chose the main project, which is in us-east.", False),
    ('{"name":"find_item","arguments":{}}', False),
])
def test_native_clarification_requires_the_right_question(monkeypatch, reply, passed):
    result, sent = run_case(monkeypatch, {"steps": [], "clarifies": ["project", "workspace"]},
                           [stream({"content": reply}, finish="stop")])
    assert result["passed"] == passed and result["tool_checks"]["arguments"] is None
    assert result["tool_checks"]["selection"] == passed
    assert len(sent) == 1


def test_unreached_action_never_passes_selection(monkeypatch):
    result, sent = run_case(monkeypatch, {"steps": [{**FIRST, "observation": {}}, FIRST]}, [stream(call(args='{"id":2}'))])
    assert len(sent) == 1 and "observation" not in result["tool_trace"][0]
    assert result["tool_trace"][0]["selection"] is True
    assert result["tool_checks"]["selection"] is False


def test_native_capability_error_is_not_a_wrong_answer(monkeypatch):
    response = httpx.Response(400, json={"error": {"message": "This model does not support tools"}})
    result, sent = run_case(monkeypatch, {"steps": [FIRST]}, [response])
    assert len(sent) == 1 and result["error"] == "This model does not support tools"
    assert result["tool_trace"][0]["status"] == 400 and result["tool_checks"]["selection"] is None
    assert result["completion_tokens"] is None


@pytest.mark.parametrize("expected, actual, passed", [
    ({"id": 1, "offset": 1}, {"id": 1}, True),
    ({"id": 1}, {"id": 1, "offset": 1, "expand": False}, True),
    ({"id": 1}, {"id": 1, "expand": 0}, False),
    ({"id": 1}, {"id": 1, "offset": True}, False),
    ({"id": 1}, {"id": 1, "unknown": False}, False),
    ({"id": 1}, {"id": 1, "offset": 2}, False),
    ({"id": 1}, {}, False),
])
def test_only_documented_optional_defaults_are_equivalent(monkeypatch, expected, actual, passed):
    tool = spec("find_item")
    props = tool["function"]["parameters"]["properties"]
    props["id"]["default"] = 1  # A required argument stays required.
    props["offset"] = {"type": "integer", "default": 1}
    props["expand"] = {"type": "boolean", "default": False}
    raw = json.dumps(actual)
    result, _ = run_case(monkeypatch, {"steps": [{"name": "find_item", "arguments": expected}]},
                         [stream(call(args=raw))], {**TASK, "tools": [tool]})
    assert result["passed"] is passed and result["tool_checks"]["arguments"] is passed
    assert result["tool_trace"][0]["calls"][0]["arguments"] == raw


def test_interrupted_native_call_keeps_the_partial_trace_without_retry(monkeypatch):
    result, sent = run_case(monkeypatch, {"steps": [FIRST]}, [stream(call(args='{'), finish=None)])
    assert len(sent) == 1 and "closed" in result["error"]
    assert result["tool_trace"][0]["calls"][0]["arguments"] == "{"
    assert result["tool_checks"]["format"] is None
