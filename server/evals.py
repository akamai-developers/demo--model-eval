"""Evals: tasks, graders, and the run loop.

A task is a system prompt plus examples. Each example has an input and an
expected answer. A run sends every example to every chosen model, grades the
reply with plain code, and keeps the reply so you can read it.

No grader calls a model. A pass means the rule below held, nothing more.
"""

import asyncio
import json
import logging
import re
import statistics
import time
import unicodedata
from decimal import Decimal, InvalidOperation
from pathlib import Path

from . import akamai, config
from .storage import create_json, write_json

GRADERS = {
    "match": "Matches one of the accepted answers. Case, quotes and end punctuation are ignored.",
    "exact": "Equals the expected text exactly, after trimming whitespace.",
    "json": "Parses as JSON and equals the expected value. A code fence fails.",
    "checks": "Counts and required or banned words. It checks limits, not writing quality.",
}
CHECK_KEYS = {"includes", "any_of", "excludes", "min_words", "max_words", "min_items", "max_items", "max_item_words"}
CHECKPOINT_SECONDS = 5
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- graders

QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', " ": " "})
LIST_MARKER = r"^\s*(?:[-*•]|\d{1,3}[.)])\s+"
LIST_ITEM = re.compile(LIST_MARKER + r"(\S.*)$")


def normalize(text: str) -> str:
    """Ignore presentation without erasing signs, decimals, or code operators."""
    text = " ".join(unicodedata.normalize("NFKC", text).translate(QUOTES).split()).casefold()
    for _ in range(4):  # strip matched wrappers such as **bold** or "quotes"
        mark = next(
            (m for m in ("**", "__", "`", '"', "'", "*", "_")
             if len(text) > 2 * len(m) and text.startswith(m) and text.endswith(m)),
            None,
        )
        if not mark:
            break
        text = text[len(mark):-len(mark)].strip()
    text = text.removeprefix("¿").removeprefix("¡")
    if any(ch.isalpha() for ch in text) and _number(text) is None:
        text = text.rstrip(".!?")
    return text


def _number(text: str):
    text = text.replace("−", "-")
    if not re.fullmatch(r"[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?", text):
        return None
    try:
        value = Decimal(text.replace(",", ""))
        return value if value.is_finite() else None
    except InvalidOperation:
        return None


def same_answer(reply: str, accepted: str) -> bool:
    a, b = normalize(reply), normalize(accepted)
    if a == b:
        return bool(a)
    x, y = _number(a), _number(b)
    return x is not None and y is not None and x == y  # 7.5 and 7.50 are one answer


def count_words(text: str) -> int:
    lines = (re.sub(LIST_MARKER, "", line) for line in text.splitlines())
    return sum(1 for line in lines for token in line.split() if any(ch.isalnum() for ch in token))


def list_items(text: str) -> list[str]:
    return [m.group(1).strip() for m in map(LIST_ITEM.match, text.splitlines()) if m]


def check_failures(reply: str, expected: dict) -> list[str]:
    """Which checks the reply fails, as short sentences. Empty means it passes."""
    text = " ".join(unicodedata.normalize("NFKC", reply).translate(QUOTES).split()).casefold()

    def has(phrase):
        return " ".join(phrase.translate(QUOTES).split()).casefold() in text

    failures = [f'Missing "{p}"' for p in expected.get("includes") or [] if not has(p)]
    options = expected.get("any_of") or []
    if options and not any(has(p) for p in options):
        failures.append("Needs one of: " + ", ".join(f'"{o}"' for o in options))
    failures += [f'Contains "{p}"' for p in expected.get("excludes") or [] if has(p)]
    words = count_words(reply)
    if expected.get("min_words") is not None and words < expected["min_words"]:
        failures.append(f"{words} words. Needs at least {expected['min_words']}")
    if expected.get("max_words") is not None and words > expected["max_words"]:
        failures.append(f"{words} words. Limit is {expected['max_words']}")
    items = list_items(reply)
    if expected.get("min_items") is not None and len(items) < expected["min_items"]:
        failures.append(f"{len(items)} list items. Needs at least {expected['min_items']}")
    if expected.get("max_items") is not None and len(items) > expected["max_items"]:
        failures.append(f"{len(items)} list items. Limit is {expected['max_items']}")
    if expected.get("max_item_words") is not None:
        longest = max((count_words(item) for item in items), default=0)
        if longest > expected["max_item_words"]:
            failures.append(f"A list item has {longest} words. Limit is {expected['max_item_words']}")
    return failures


def _reject_constant(name):
    raise ValueError(f"{name} is not valid JSON")


def _same_json(actual, expected) -> bool:
    if isinstance(expected, dict):
        return (isinstance(actual, dict) and actual.keys() == expected.keys()
                and all(_same_json(actual[k], v) for k, v in expected.items()))
    if isinstance(expected, list):
        return (isinstance(actual, list) and len(actual) == len(expected)
                and all(_same_json(a, b) for a, b in zip(actual, expected)))
    if type(expected) in (int, float):
        # JSON has one numeric type. Preserve digits and keep booleans distinct.
        return type(actual) in (int, Decimal) and actual == Decimal(str(expected))
    return type(actual) is type(expected) and actual == expected


def grade(grader: str, reply: str, expected) -> tuple[bool, list[str]]:
    """(passed, notes). Notes say why a reply failed, when the grader can tell."""
    if grader == "exact":
        return reply.strip() == str(expected).strip(), []
    if grader == "match":
        accepted = expected if isinstance(expected, list) else [expected]
        return any(same_answer(reply, str(a)) for a in accepted), []
    if grader == "checks":
        failures = check_failures(reply, expected)
        return not failures, failures
    if grader == "json":
        try:
            parsed = json.loads(reply.strip(), parse_float=Decimal, parse_constant=_reject_constant)
        except (ValueError, InvalidOperation) as exc:
            return False, [f"Not valid JSON: {str(exc)[:120]}"]
        return _same_json(parsed, expected), []
    raise ValueError(f"Unknown grader: {grader}")


def tool_checks(result: dict) -> dict | None:
    """Explain the original tool-routing benchmark, including replies saved before detailed grading."""
    if "tool_checks" in result:
        return result["tool_checks"]
    if result.get("task") != "tool_selection" or result.get("error"):
        return None
    expected = result["expected"]
    reply = result.get("output", "").strip()
    fence = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", reply, flags=re.I | re.S)
    try:
        parsed = json.loads(fence[1] if fence else reply, parse_float=Decimal, parse_constant=_reject_constant)
    except (ValueError, InvalidOperation):
        parsed = None
    if not isinstance(parsed, dict):
        return {"selection": None, "arguments": None, "format": False, "detail": "Could not read a single JSON object."}

    tool = parsed.get("tool")
    exact_form = (not fence and parsed.keys() == {"tool", "arguments"}
                  and isinstance(tool, str) and isinstance(parsed.get("arguments"), dict))
    if "arguments" in parsed:
        arguments = parsed["arguments"]
    else:
        arguments = {k: v for k, v in parsed.items() if k != "tool"}
    checks = {"selection": tool == expected["tool"], "arguments": _same_json(arguments, expected["arguments"]),
              "format": bool(exact_form)}
    if "arguments" not in parsed and checks["arguments"]:
        checks["detail"] = "The argument values match. Place them inside the required arguments object."
    elif not exact_form:
        checks["detail"] = 'Return a bare JSON object with exactly two keys, "tool" and "arguments".'
    return checks


# ---------------------------------------------------------------- tasks

_starters: list[dict] | None = None


def starters() -> list[dict]:
    global _starters
    if _starters is None:
        tasks = [task for filename in ("evals.json", "native_tools.json")
                 for task in json.loads((config.FIXTURES / filename).read_text())]
        for task in tasks:
            task["custom"] = False
            if task["grader"] == "tool_calls":
                task["grader_version"] = "schema-defaults-v2"
        _starters = tasks
    return _starters


def _custom_dir():
    path = config.DATA / "tasks"
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def all_tasks() -> list[dict]:
    custom = [json.loads(p.read_text()) for p in sorted(_custom_dir().glob("c_*.json"))]
    return starters() + custom


def _validate_checks(expected, example_number: int):
    prefix = f"Example {example_number}"
    if not isinstance(expected, dict) or not expected or set(expected) - CHECK_KEYS:
        raise ValueError(f"{prefix}: checks can use {', '.join(sorted(CHECK_KEYS))}.")
    for key, value in expected.items():
        if key in ("includes", "any_of", "excludes"):
            if not isinstance(value, list) or not value or not all(isinstance(p, str) and p.strip() for p in value):
                raise ValueError(f"{prefix}: {key} needs a list of nonempty phrases.")
        elif type(value) is not int or value < 0:
            raise ValueError(f"{prefix}: {key} must be a nonnegative integer.")
    for unit in ("words", "items"):
        low = expected.get(f"min_{unit}")
        high = expected.get(f"max_{unit}")
        if low is not None and high is not None and low > high:
            raise ValueError(f"{prefix}: min_{unit} cannot exceed max_{unit}.")


def save_custom_task(body: dict) -> dict:
    """Validate and store a task written in the app. Raises ValueError with a readable message."""
    name = str(body.get("name") or "").strip()
    grader = body.get("grader")
    examples = body.get("examples")
    if not 1 <= len(name) <= 80:
        raise ValueError("Give the task a name of 80 characters or fewer.")
    if not isinstance(grader, str) or grader not in GRADERS:
        raise ValueError("Choose a grader: " + ", ".join(GRADERS))
    if not isinstance(examples, list) or not 1 <= len(examples) <= 50:
        raise ValueError("Add between 1 and 50 examples.")
    cleaned = []
    for n, example in enumerate(examples, 1):
        if not isinstance(example, dict):
            raise ValueError(f"Example {n} must contain an input and an expected answer.")
        text, expected = example.get("input"), example.get("expected")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"Example {n} has no input.")
        if grader == "match":
            choices = expected if isinstance(expected, list) else [expected]
            expected = [str(a).strip() for a in choices if a is not None and str(a).strip()]
            if not expected:
                raise ValueError(f"Example {n} needs at least one accepted answer.")
        elif grader == "exact":
            if not isinstance(expected, str) or not expected.strip():
                raise ValueError(f"Example {n} needs an expected answer.")
        elif grader == "checks":
            _validate_checks(expected, n)
        elif "expected" not in example:
            raise ValueError(f"Example {n} needs an expected JSON value.")
        else:
            try:
                json.dumps(expected, allow_nan=False)
            except ValueError as exc:
                raise ValueError(f"Example {n} contains a nonfinite JSON number.") from exc
        cleaned.append({"id": f"ex_{n:02d}", "input": text.strip()[:8000], "expected": expected})
    task = {
        "name": name,
        "group": "Yours",
        "goal": str(body.get("goal") or "").strip()[:200],
        "grader": grader,
        "system": str(body.get("system") or "").strip()[:4000],
        "notes": GRADERS[grader],
        "examples": cleaned,
        "custom": True,
    }
    create_json(_custom_dir(), "c", task, indent=1)
    return task


def delete_custom_task(task_id: str) -> bool:
    path = _custom_dir() / f"{task_id}.json"
    if not re.fullmatch(r"c_[0-9a-f]{8}", task_id) or not path.exists():
        return False
    path.unlink()
    return True


# ---------------------------------------------------------------- runs

RUNS: dict[str, dict] = {}
_jobs: dict[str, asyncio.Task] = {}
_history: dict[Path, tuple[int, dict]] = {}
RUN_ID = re.compile(r"r_[0-9a-f]{8}")


def _runs_dir():
    path = config.DATA / "runs"
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def _save(run: dict):
    write_json(_runs_dir() / f"{run['id']}.json", run)


def _read_snapshot(path: Path) -> dict:
    run = json.loads(path.read_text(encoding="utf-8"))
    if run["status"] == "running":  # Only live jobs can resume in this process.
        run["status"] = "stopped"
        run["finished"] = run.get("finished") or path.stat().st_mtime
        _save(run)
    return run


def get_run(run_id: str) -> dict | None:
    if run_id in RUNS:
        return RUNS[run_id]
    path = _runs_dir() / f"{run_id}.json"
    return _read_snapshot(path) if RUN_ID.fullmatch(run_id) and path.is_file() else None


def _history_row(run: dict) -> dict:
    return {k: run.get(k) for k in ("id", "started", "status", "models", "total", "done", "reasoning")} | {
        "tasks": [task["name"] for task in run["tasks"]]
    }


def list_runs(limit: int | None = None) -> list[dict]:
    paths = {p for p in _runs_dir().glob("r_*.json") if RUN_ID.fullmatch(p.stem) and p.stem not in RUNS}
    for missing in _history.keys() - paths:
        del _history[missing]
    rows = [_history_row(run) for run in RUNS.values()]
    for path in paths:
        modified = path.stat().st_mtime_ns
        cached = _history.get(path)
        if cached is None or cached[0] != modified:
            cached = (modified, _history_row(_read_snapshot(path)))
            _history[path] = cached
        rows.append(cached[1])
    return sorted(rows, key=lambda row: row["started"], reverse=True)[:limit]


def delete_run(run_id: str) -> bool:
    run = get_run(run_id)
    if not run or run["status"] == "running":
        return False
    RUNS.pop(run_id, None)
    (_runs_dir() / f"{run_id}.json").unlink(missing_ok=True)
    return True


def _median(values):
    values = [v for v in values if v is not None]
    return round(statistics.median(values), 1) if values else None


def summarize(run: dict) -> dict:
    """The run without its replies: one cell per model and task, one row per model."""
    by_cell: dict[tuple, list] = {}
    for result in run["results"]:
        by_cell.setdefault((result["model"], result["task"]), []).append(result)
    rows = []
    for model in run["models"]:
        cells, rates, model_results = {}, [], []
        for task in run["tasks"]:
            results = by_cell.get((model, task["id"]), [])
            model_results += results
            passed = sum(1 for r in results if r["passed"])
            cells[task["id"]] = {
                "done": len(results),
                "total": task["examples"],
                "passed": passed,
                "errors": sum(1 for r in results if r.get("error")),
            }
            if task["id"] == "tool_selection" or task["grader"] == "tool_calls":
                checks = [tool_checks(r) for r in results]
                cells[task["id"]]["right_tool"] = sum(c is not None and c.get("selection") is True for c in checks)
            if results:
                rates.append(passed / len(results))
        rows.append({
            "model": model,
            "cells": cells,
            # Mean of the task pass rates, so a task with more examples does not count for more.
            "score": round(sum(rates) / len(rates), 4) if rates else None,
            "passed": sum(c["passed"] for c in cells.values()),
            "done": len(model_results),
            "errors": sum(c["errors"] for c in cells.values()),
            "median_ms": _median([r.get("total_ms") for r in model_results]),
            "median_ttft_ms": _median([r.get("ttft_ms") for r in model_results]),
            "tokens_per_second": _median([r.get("tokens_per_second") for r in model_results]),
            "completion_tokens": sum(r.get("completion_tokens") or 0 for r in model_results),
        })
    summary = {k: v for k, v in run.items() if k != "results"}
    summary["rows"] = rows
    summary["elapsed_ms"] = round(((run.get("finished") or time.time()) - run["started"]) * 1000)
    # Above zero while the run waits out the endpoint's rate limit.
    summary["rate_limit_wait_ms"] = round(akamai.rate_limit_wait() * 1000) if run["status"] == "running" else 0
    return summary


def explain_result(result: dict) -> dict:
    checks = tool_checks(result)
    return result | {"tool_checks": checks} if checks is not None else result


def cell_results(run: dict, model: str, task_id: str) -> list[dict]:
    return [explain_result(r) for r in run["results"] if r["model"] == model and r["task"] == task_id]


def compare_runs(baseline: dict, selected: dict) -> dict:
    """Compare completed replies to the same graded example in both saved runs."""
    def index(run):
        tasks = {t["id"]: t for t in run["tasks"]}
        by_model = {model: {} for model in run["models"]}
        for r in run["results"]:
            task = tasks[r["task"]]
            key = (r["task"], r["example"], r["input"], task["grader"], task.get("grader_version"),
                   json.dumps(r["expected"], sort_keys=True, ensure_ascii=False))
            by_model[r["model"]][key] = r
        return by_model

    def stats(results):
        tokens = [r.get("completion_tokens") for r in results]
        return {
            "passed": sum(r["passed"] for r in results),
            "median_ms": _median([r.get("total_ms") for r in results]),
            "tokens": sum(tokens) if tokens and None not in tokens else None,
        }

    left, right = index(baseline), index(selected)
    rows = []
    for model in sorted(left.keys() | right.keys()):
        a, b = left.get(model, {}), right.get(model, {})
        shared = a.keys() & b.keys()
        tool_choices = []
        for key in shared:
            before, after = tool_checks(a[key]), tool_checks(b[key])
            if before and after and before["selection"] is not None and after["selection"] is not None:
                tool_choices.append((before["selection"], after["selection"]))
        rows.append({
            "model": model, "shared": len(shared),
            "baseline_done": len(a), "selected_done": len(b),
            "baseline": stats([a[k] for k in shared]), "selected": stats([b[k] for k in shared]),
            "improved": sum(not a[k]["passed"] and b[k]["passed"] for k in shared),
            "regressed": sum(a[k]["passed"] and not b[k]["passed"] for k in shared),
            "tool_pairs": len(tool_choices),
            "baseline_right_tool": sum(before for before, _ in tool_choices),
            "selected_right_tool": sum(after for _, after in tool_choices),
        })
    return {"rows": rows, "running": baseline["status"] == "running" or selected["status"] == "running"}


async def _run_one(run: dict, model: str, task: dict, example: dict):
    messages = [{"role": "user", "content": example["input"]}]
    if task["system"]:
        messages.insert(0, {"role": "system", "content": task["system"]})
    # Reasoning tokens count against max_tokens, so leave room when thinking may be on.
    budget = 1024 if run["reasoning"] == "off" else 4096
    body = akamai.request_body(model, messages, max_tokens=budget, temperature=0, reasoning=run["reasoning"])
    native = task["grader"] == "tool_calls"
    try:
        if native:
            from .tool_evals import evaluate
            reply = await evaluate({**body, "tools": task["tools"]}, example["expected"])
        else:
            reply = await akamai.complete(body)
    except Exception as exc:
        logger.exception("Request failed for model %s, example %s", model, example["id"])
        reply = {"content": "", "reasoning": "", "error": f"Request failed ({type(exc).__name__})."}
    result = {
        "model": model,
        "task": task["id"],
        "example": example["id"],
        "input": example["input"],
        "expected": example["expected"],
        "output": reply["content"],
        "reasoning": reply["reasoning"][:4000],
        **{k: reply.get(k) for k in ("ttft_ms", "total_ms", "prompt_tokens", "completion_tokens", "reasoning_tokens", "tokens_per_second", "finish_reason")},
    }
    if native:
        result.update(tool_trace=reply.get("tool_trace", []), tool_checks=reply.get("tool_checks", dict.fromkeys(("selection", "arguments", "format"))))
    if reply.get("error"):
        result |= {"passed": False, "notes": [], "error": reply["error"]}
    elif native:
        result |= {"passed": reply["passed"], "notes": reply["notes"]}
    else:
        try:
            passed, notes = grade(task["grader"], reply["content"], example["expected"])
        except Exception as exc:  # a malformed expected value must not stall the run
            passed, notes = False, [f"Grader failed: {exc}"]
        if not passed and reply.get("finish_reason") == "length":
            notes = notes + [f"Cut off at {budget} output tokens"]
        result |= {"passed": passed, "notes": notes}
    if (checks := tool_checks(result)) is not None:
        result["tool_checks"] = checks
    return result


async def _execute(run: dict, tasks: list[dict]):
    longest = max(len(t["examples"]) for t in tasks)
    # Interleave models and tasks so every part of the table starts filling early.
    pending = (
        (model, task, task["examples"][i])
        for i in range(longest)
        for task in tasks
        if i < len(task["examples"])
        for model in run["models"]
    )
    next_checkpoint = 0.0

    async def worker():
        nonlocal next_checkpoint
        for model, task, example in pending:
            result = await _run_one(run, model, task, example)
            run["results"].append(result)
            run["done"] += 1
            if time.monotonic() >= next_checkpoint:
                _save(run)
                next_checkpoint = time.monotonic() + CHECKPOINT_SECONDS

    async with asyncio.TaskGroup() as group:
        for _ in range(min(config.EVAL_CONCURRENCY, run["total"])):
            group.create_task(worker())


def _finish_run(run: dict, job: asyncio.Task):
    # A done callback also runs if stop was requested before _execute started.
    error = None if job.cancelled() else job.exception()
    if error is not None:
        logger.error("Run %s stopped unexpectedly", run["id"], exc_info=error)
    run["status"] = "stopped" if job.cancelled() or error is not None else "done"
    run["finished"] = time.time()
    _jobs.pop(run["id"], None)
    _save(run)
    RUNS.pop(run["id"], None)


def start_run(models: list[str], task_ids: list[str], reasoning: str = "off", limit: int | None = None) -> dict:
    known = {t["id"]: t for t in all_tasks()}
    tasks = []
    models = list(dict.fromkeys(models))
    for task_id in dict.fromkeys(task_ids):
        if task_id not in known:
            raise ValueError(f"Unknown task: {task_id}")
        task = dict(known[task_id])
        task["examples"] = task["examples"][:limit] if limit else task["examples"]
        tasks.append(task)
    if not tasks or not models:
        raise ValueError("Choose at least one task and one model.")
    if reasoning not in ("off", "default", "on"):
        raise ValueError("reasoning must be off, default or on.")
    run = {
        "started": time.time(),
        "finished": None,
        "status": "running",
        "models": models,
        "reasoning": reasoning,
        "tasks": [
            {"id": t["id"], "name": t["name"], "grader": t["grader"], "examples": len(t["examples"]),
             **({"grader_version": t["grader_version"]} if "grader_version" in t else {})}
            for t in tasks
        ],
        "total": len(models) * sum(len(t["examples"]) for t in tasks),
        "done": 0,
        "results": [],
    }
    create_json(_runs_dir(), "r", run)
    RUNS[run["id"]] = run
    job = asyncio.create_task(_execute(run, tasks))
    _jobs[run["id"]] = job
    job.add_done_callback(lambda finished: _finish_run(run, finished))
    return run


def stop_run(run_id: str) -> bool:
    job = _jobs.get(run_id)
    if job:
        job.cancel()
    return bool(job)
