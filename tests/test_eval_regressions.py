import asyncio
import json
from unittest.mock import Mock

import pytest

from server import akamai, config, evals, storage
from tests.conftest import calls
from tests.test_api import wait


@pytest.mark.parametrize("example", [
    None,
    {"input": "answer", "expected": {"includes": "refund"}},
    {"input": "answer", "expected": {"any_of": [1]}},
    {"input": "answer", "expected": {"max_words": "10"}},
    {"input": "answer", "expected": {"min_words": True}},
    {"input": "answer", "expected": {"min_items": 3, "max_items": 2}},
])
def test_invalid_checks_are_rejected_before_saving(client, example):
    body = {"name": "My checks", "grader": "checks", "examples": [example]}
    response = client.post("/api/evals/tasks", json=body)
    assert response.status_code == 422
    assert "Example 1" in response.json()["detail"]
    assert not any(task["custom"] for task in client.get("/api/evals/tasks").json()["tasks"])


def test_explicit_null_is_a_json_answer(client):
    example = {"input": "Return null", "expected": None}
    body = {"name": "Null", "grader": "json", "examples": [example]}
    assert client.post("/api/evals/tasks", json=body).status_code == 200
    del example["expected"]
    assert client.post("/api/evals/tasks", json=body).status_code == 422


@pytest.mark.parametrize(("reply", "expected", "passes"), [
    ('{"items":[1.0,1e0]}', {"items": [1, 1]}, True),
    ('{"items":[true]}', {"items": [1]}, False),
    ('{"items":[1]}', {"items": [True]}, False),
    ("9007199254740993.0", 9007199254740993, True),
    ("9007199254740992.9", 9007199254740993, False),
    ("0.1000000000000000001", 0.1, False),
])
def test_json_numbers_compare_by_value(reply, expected, passes):
    assert evals.grade("json", reply, expected)[0] is passes


@pytest.mark.parametrize("number", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_expected_values_are_rejected_before_saving(client, number):
    example = {"input": "Return JSON", "expected": {"nested": [number]}}
    body = {"name": "Invalid number", "grader": "json", "examples": [example]}
    response = client.post("/api/evals/tasks", content=json.dumps(body), headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert not any(task["custom"] for task in client.get("/api/evals/tasks").json()["tasks"])


def test_duplicate_tasks_do_not_inflate_run_counts(client):
    body = {"models": ["alpha"], "tasks": ["sentiment", "sentiment"], "limit": 1}
    run = client.post("/api/evals/runs", json=body).json()
    run = wait(client, f"/api/evals/runs/{run['id']}", lambda r: r["status"] == "done")
    assert calls["alpha"] == run["total"] == run["done"] == run["rows"][0]["done"] == 1


def test_endpoint_exception_records_an_error_and_finishes_other_examples(client, monkeypatch):
    complete = akamai.complete

    async def flaky(body):
        if body["model"] == "wrong":
            raise RuntimeError("Unexpected response")
        return await complete(body)

    monkeypatch.setattr(akamai, "complete", flaky)
    body = {"models": ["wrong", "alpha"], "tasks": ["sentiment"], "limit": 1}
    run = client.post("/api/evals/runs", json=body).json()
    run = wait(client, f"/api/evals/runs/{run['id']}", lambda r: r["status"] == "done")
    assert run["total"] == run["done"] == 2
    failed, ok = run["rows"]
    assert failed["errors"] == 1 and ok["errors"] == 0


def test_stop_before_first_request_persists_terminal_status(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA", tmp_path)

    async def stop_immediately():
        run = evals.start_run(["alpha"], ["sentiment"], limit=1)
        job = evals._jobs[run["id"]]
        assert evals.stop_run(run["id"])
        await asyncio.gather(job, return_exceptions=True)
        return run["id"]

    run_id = asyncio.run(stop_immediately())
    saved = json.loads((tmp_path / "runs" / f"{run_id}.json").read_text())
    assert saved["status"] == "stopped" and saved["done"] == 0
    assert saved["finished"] and run_id not in evals._jobs


def test_large_run_bounds_workers_and_preserves_completed_reply_on_stop(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA", tmp_path)
    monkeypatch.setattr(config, "EVAL_CONCURRENCY", 2)
    monkeypatch.setattr(evals, "RUNS", {})
    monkeypatch.setattr(evals, "_jobs", {})

    async def exercise():
        requests = asyncio.Queue()

        async def complete(body):
            reply = asyncio.get_running_loop().create_future()
            requests.put_nowait((body["model"], reply))
            return await reply

        monkeypatch.setattr(akamai, "complete", complete)
        existing = asyncio.all_tasks()
        run = evals.start_run(["first", "second"], ["sentiment", "spelling_grammar"])
        job = evals._jobs[run["id"]]
        async with asyncio.timeout(5):
            first_model, first = await requests.get()
            second_model, second = await requests.get()
            assert (first_model, second_model) == ("first", "second")
            assert len(asyncio.all_tasks() - existing - {job}) == 2

            first.set_result({"content": "positive", "reasoning": ""})
            third_model, third = await requests.get()
            assert third_model == "first"
            assert run["done"] == 1 and run["total"] > 3
            path = tmp_path / "runs" / f"{run['id']}.json"
            assert json.loads(path.read_text())["done"] == 1
            assert evals.stop_run(run["id"])
            await asyncio.gather(job, return_exceptions=True)
            assert second.cancelled() and third.cancelled() and requests.empty()
            saved = json.loads(path.read_text())
            assert saved["status"] == "stopped" and saved["done"] == len(saved["results"]) == 1
            assert saved["results"][0]["task"] == "sentiment"

    asyncio.run(exercise())


def test_restarted_server_recovers_checkpoint(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA", tmp_path)
    run_id = "r_deadbeef"
    path = tmp_path / "runs" / f"{run_id}.json"
    path.parent.mkdir()
    path.write_text(json.dumps({"id": run_id, "status": "running", "done": 2, "finished": None}))
    run = evals.get_run(run_id)
    assert run["status"] == "stopped" and run["done"] == 2
    assert run["finished"] and json.loads(path.read_text()) == run
    assert evals.delete_run(run_id)


def test_new_runs_and_tasks_do_not_overwrite_colliding_ids(client, tmp_path, monkeypatch):
    ids = ["11111111", "11111111", "22222222", "33333333", "33333333", "44444444"]
    monkeypatch.setattr(storage.secrets, "token_hex", Mock(side_effect=ids))
    task = {"name": "Original", "grader": "exact", "examples": [{"input": "Say yes", "expected": "yes"}]}
    assert client.post("/api/evals/tasks", json=task).json()["id"] == "c_11111111"
    original = tmp_path / "tasks" / "c_11111111.json"
    saved = original.read_bytes()
    assert client.post("/api/evals/tasks", json=task | {"name": "Second"}).json()["id"] == "c_22222222"
    assert original.read_bytes() == saved

    def finish_run():
        body = {"models": ["alpha"], "tasks": ["sentiment"], "limit": 1}
        run_id = client.post("/api/evals/runs", json=body).json()["id"]
        wait(client, f"/api/evals/runs/{run_id}", lambda run: run["status"] == "done")
        return run_id

    assert finish_run() == "r_33333333"
    original_run = tmp_path / "runs" / "r_33333333.json"
    saved_run = original_run.read_bytes()
    assert finish_run() == "r_44444444"
    assert original_run.read_bytes() == saved_run


def test_history_reuses_summaries_and_loads_full_replies_on_demand(client, monkeypatch):
    body = {"models": ["alpha"], "tasks": ["sentiment"], "limit": 1}
    run_id = client.post("/api/evals/runs", json=body).json()["id"]
    wait(client, f"/api/evals/runs/{run_id}", lambda run: run["status"] == "done")
    assert run_id not in evals.RUNS
    read = Mock(wraps=evals._read_snapshot)
    monkeypatch.setattr(evals, "_read_snapshot", read)
    runs = client.get("/api/evals/runs").json()["runs"]
    assert runs[0]["id"] == run_id and "results" not in runs[0]
    assert client.get("/api/evals/runs").json()["runs"] == runs
    read.assert_called_once()
    results = client.get(f"/api/evals/runs/{run_id}/results?model=alpha&task=sentiment").json()["results"]
    assert results[0]["output"] and run_id not in evals.RUNS
