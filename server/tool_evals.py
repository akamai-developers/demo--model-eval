"""Grade native function calls against fixture data. Observations are never executed."""

import json
import re
import time
from decimal import Decimal

from . import akamai
from .evals import _reject_constant, _same_json, same_answer

DIMENSIONS = ("format", "selection", "arguments")
TOKENS = ("prompt_tokens", "completion_tokens", "reasoning_tokens")
METRICS = (*TOKENS, "ttft_ms", "total_ms", "finish_reason")


def _unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate argument key {key!r}")
        result[key] = value
    return result


def _text_call(content):
    if re.search(r"<(?:tool_call|function[=>])", content, re.I):
        return True
    text = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", content, flags=re.I)
    try:
        value = json.loads(text)
    except (ValueError, RecursionError):
        return False
    candidates = value if isinstance(value, list) else [value]
    return any(isinstance(v, dict) and ("tool_calls" in v or "function" in v or "tool" in v
               or ("name" in v and "arguments" in v)) for v in candidates)


def _asks_for_field(text, fields):
    request = (
        r"(?:^\s*(?:which|what|specify|provide|confirm)\b|"
        r"\bplease\s+(?:provide|specify|share|confirm|choose|clarify|identify|tell)\b|"
        r"\b(?:i|we)\s+(?:need|require)\b|\b(?:can|could|would)\s+you\b)"
    )
    for sentence in re.findall(r"[^.!?\n]+[.!?]?", text.casefold()):
        if any(re.search(r"(?<!\w)" + re.escape(field.casefold()) + r"(?!\w)", sentence) for field in fields):
            if "?" in sentence or re.search(request, sentence):
                return True
    return False


def _with_defaults(value, schema, *, parsed):
    """Resolve only optional defaults stated in the selected tool's schema."""
    if isinstance(value, dict):
        result = dict(value)
        for key, prop in schema.get("properties", {}).items():
            if key not in result and key not in schema.get("required", []) and "default" in prop:
                result[key] = prop["default"]
            if key in result:
                result[key] = _with_defaults(result[key], prop, parsed=parsed)
        return result
    if isinstance(value, list) and "items" in schema:
        return [_with_defaults(item, schema["items"], parsed=parsed) for item in value]
    # Parsed arguments use Decimal even when their value comes from a float default.
    if parsed and isinstance(value, float):
        return Decimal(str(value))
    return value


def _grade_stage(stage, reply, step, expected, schemas):
    notes = list(reply.get("tool_format_errors", []))
    parsed = []
    ids = set()
    for call in reply.get("tool_calls", []):
        fn = call["function"]
        stage["calls"].append({"id": call["id"], "type": call["type"], "name": fn["name"], "arguments": fn["arguments"]})
        if not call["id"].strip() or call["id"] in ids:
            notes.append("Each call needs a unique, nonempty ID.")
        ids.add(call["id"])
        if call["type"] != "function" or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", fn["name"]):
            notes.append("Expected a native function envelope with a valid name.")
        try:
            args = json.loads(fn["arguments"], parse_constant=_reject_constant, parse_float=Decimal,
                              object_pairs_hook=_unique_keys)
            if not isinstance(args, dict):
                raise ValueError("expected an object")
        except (ValueError, RecursionError) as exc:
            notes.append(f"Invalid JSON arguments: {str(exc)[:120]}")
            args = None
        parsed.append(args)
    calls = stage["calls"]
    text_call = not calls and _text_call(stage["output"])
    if text_call:
        notes.append("A tool call was written as message text.")
    if step and not calls and not text_call:
        notes.append("No native tool call was returned.")
    if reply.get("finish_reason") == "length":
        notes.append("The model reached its output token limit.")
    stage["format"] = not notes
    if step:
        names = [call["name"] for call in calls]
        stage["selection"] = names == [step["name"]]
        if not stage["selection"]:
            notes.append(f"Expected one call to {step['name']}.")
        elif parsed[0] is not None:
            schema = schemas[step["name"]]
            stage["arguments"] = _same_json(_with_defaults(parsed[0], schema, parsed=True),
                                            _with_defaults(step["arguments"], schema, parsed=False))
            if not stage["arguments"]:
                notes.append("Arguments differ from the expected values or types.")
    else:
        stage["selection"] = not calls and not text_call
        if not stage["selection"]:
            notes.append("Expected a response without a tool call.")
        text = stage["output"].strip()
        if not text:
            notes.append("Expected a text response.")
            stage["selection"] = False
        elif expected.get("answer") and not any(same_answer(text, a) for a in expected["answer"]):
            notes.append("The final response differs from the expected answer.")
        elif expected.get("clarifies") and not _asks_for_field(text, expected["clarifies"]):
            notes.append("The response did not ask for the missing information.")
            stage["selection"] = False
    return notes


async def evaluate(body, expected):
    steps = expected["steps"]
    answer_turn = not steps or "answer" in expected or "clarifies" in expected
    count = len(steps) + int(answer_turn)
    if not 1 <= count <= 3:
        raise ValueError("A native tool case must take one to three assistant turns.")
    messages = list(body["messages"])
    schemas = {tool["function"]["name"]: tool["function"]["parameters"] for tool in body["tools"]}
    trace, notes, reasoning = [], [], []
    started = time.perf_counter()
    error = None
    for i in range(count):
        step = steps[i] if i < len(steps) else None
        reply = await akamai.complete({**body, "messages": messages, "tool_choice": "auto"})
        stage = {
            "step": i + 1, "expected": ({"name": step["name"], "arguments": step["arguments"]} if step else None),
            "calls": [], "output": reply["content"], **dict.fromkeys(DIMENSIONS),
            **{key: reply.get(key) for key in METRICS},
        }
        trace.append(stage)
        if reply.get("reasoning"):
            reasoning.append(reply["reasoning"])
        failed = _grade_stage(stage, reply, step, expected, schemas)
        if reply.get("error"):
            error = stage["error"] = reply["error"]
            stage["status"] = reply.get("status")
            stage.update(dict.fromkeys(DIMENSIONS))
            break
        if failed:
            stage["notes"] = failed
            notes.extend(f"Step {i + 1}: {note}" for note in failed)
            break
        if i + 1 < count:
            call = reply["tool_calls"][0]
            stage["observation"] = step["observation"]
            messages += [
                {"role": "assistant", "content": reply["content"] or None, "tool_calls": [call],
                 **({"reasoning_content": reply["reasoning"]} if reply.get("reasoning") else {})},
                {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(step["observation"], ensure_ascii=False)},
            ]

    checks = {}
    for key in DIMENSIONS:
        # No-call turns have no arguments to evaluate.
        relevant = [s[key] for s in trace if key != "arguments" or s["expected"]]
        if False in relevant or (key == "selection" and not error and len(trace) < count):
            checks[key] = False
        elif not relevant or None in relevant or (len(trace) < (len(steps) if key == "arguments" else count)):
            checks[key] = None
        else:
            checks[key] = True
    if notes or error:
        checks["detail"] = error or " ".join(notes)
    usage = {}
    for key in TOKENS:
        values = [s[key] for s in trace]
        usage[key] = sum(values) if None not in values else None
    decode = sum(s["total_ms"] - s["ttft_ms"] for s in trace if s["total_ms"] is not None and s["ttft_ms"] is not None)
    timed = all(s["total_ms"] is not None and s["ttft_ms"] is not None for s in trace)
    return {
        "passed": not error and not notes, "notes": notes, "tool_trace": trace, "tool_checks": checks,
        "content": trace[-1]["output"], "reasoning": "\n".join(reasoning),
        "total_ms": round((time.perf_counter() - started) * 1000), "ttft_ms": trace[0]["ttft_ms"],
        "tokens_per_second": round(1000 * usage["completion_tokens"] / decode, 1) if timed and decode > 50 and usage["completion_tokens"] else None,
        "finish_reason": trace[-1]["finish_reason"], **usage, **({"error": error} if error else {}),
    }
