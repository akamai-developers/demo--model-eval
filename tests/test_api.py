import json
import time

from server import config, sites
from tests.conftest import calls


def wait(client, url, done, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = client.get(url).json()
        if done(data):
            return data
        time.sleep(0.05)
    raise AssertionError(f"{url} did not finish: {data}")


def test_models_come_from_the_endpoint_with_output_limits(client):
    models = client.get("/api/models").json()["models"]
    by_id = {m["id"]: m for m in models}
    assert by_id["alpha"] == {"id": "alpha", "kind": "chat", "max_output_tokens": 4096}
    assert by_id["test-embedding"]["kind"] == "embedding"
    assert by_id["test-embedding"]["max_output_tokens"] is None
    assert by_id["thinker"]["max_output_tokens"] is None
    assert client.get("/api/models?refresh=true").status_code == 200
    assert calls == {}


def test_missing_key_is_a_clear_error(client, monkeypatch):
    monkeypatch.setattr(config, "API_KEY", "")
    response = client.get("/api/models?refresh=true")
    assert response.status_code == 503
    assert "AKAMAI_API_KEY" in response.json()["detail"]
    assert client.get("/api/config").json() == {"base_url": "https://fake.test/v1", "key_set": False}


def test_chat_streams_deltas_then_metrics(client):
    body = {"model": "thinker", "messages": [{"role": "user", "content": "hi"}], "reasoning": "on"}
    with client.stream("POST", "/api/chat", json=body) as response:
        events = [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]
    assert events[0] == {"type": "delta", "content": "", "reasoning": "Let me think."}
    assert "".join(e["content"] for e in events if e["type"] == "delta") == "positive"
    done = events[-1]
    assert done["type"] == "done" and done["finish_reason"] == "stop"
    assert done["completion_tokens"] == 2 and done["ttft_ms"] is not None


def test_chat_rejects_unknown_and_embedding_models(client):
    for model in ("nope", "test-embedding"):
        response = client.post("/api/chat", json={"model": model, "messages": [{"role": "user", "content": "hi"}]})
        assert response.status_code == 422


def test_chat_passes_endpoint_errors_through(client):
    body = {"model": "broken", "messages": [{"role": "user", "content": "hi"}]}
    with client.stream("POST", "/api/chat", json=body) as response:
        events = [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]
    assert events == [{"type": "error", "status": 400, "message": "The model is unavailable.", "retry_after": None}]


def test_eval_run_grades_every_example(client):
    body = {"models": ["alpha", "wrong", "broken"], "tasks": ["sentiment"], "limit": 4}
    run = client.post("/api/evals/runs", json=body).json()
    assert run["total"] == 12 and run["status"] == "running"
    run = wait(client, f"/api/evals/runs/{run['id']}", lambda r: r["status"] == "done")
    rows = {row["model"]: row for row in run["rows"]}
    assert rows["alpha"]["cells"]["sentiment"]["done"] == 4
    assert rows["wrong"]["score"] == 0
    assert rows["broken"]["errors"] == 4 and rows["broken"]["score"] == 0
    assert rows["alpha"]["score"] > 0

    results = client.get(f"/api/evals/runs/{run['id']}/results?model=broken&task=sentiment").json()["results"]
    assert len(results) == 4 and results[0]["error"] == "The model is unavailable."
    # The run is on disk and listed.
    assert (config.DATA / "runs" / f"{run['id']}.json").exists()
    assert client.get("/api/evals/runs").json()["runs"][0]["id"] == run["id"]


def test_rate_limited_request_is_retried(client):
    body = {"models": ["limited"], "tasks": ["sentiment"], "limit": 2}
    run = client.post("/api/evals/runs", json=body).json()
    run = wait(client, f"/api/evals/runs/{run['id']}", lambda r: r["status"] == "done")
    assert run["rows"][0]["errors"] == 0 and run["rows"][0]["done"] == 2
    assert calls["limited"] == 3  # one 429, then both examples answered


def test_custom_task_round_trip(client):
    task = {
        "name": "Arithmetic",
        "system": "Return only the number.",
        "grader": "match",
        "examples": [{"input": "17 * 23", "expected": ["391"]}, {"input": "1 + 1", "expected": ["2"]}],
    }
    saved = client.post("/api/evals/tasks", json=task).json()
    assert saved["custom"] and saved["id"].startswith("c_")
    assert any(t["id"] == saved["id"] for t in client.get("/api/evals/tasks").json()["tasks"])

    run = client.post("/api/evals/runs", json={"models": ["alpha"], "tasks": [saved["id"]]}).json()
    run = wait(client, f"/api/evals/runs/{run['id']}", lambda r: r["status"] == "done")
    assert run["rows"][0]["cells"][saved["id"]] == {"done": 2, "total": 2, "passed": 1, "errors": 0}

    assert client.post("/api/evals/tasks", json={**task, "examples": []}).status_code == 422
    assert client.delete(f"/api/evals/tasks/{saved['id']}").status_code == 200
    assert client.delete("/api/evals/tasks/sentiment").status_code == 404


def test_site_build_saves_and_sandboxes_pages(client):
    prompt = client.get("/api/sites/challenges").json()["challenges"][0]["prompt"]
    body = {"models": ["alpha", "fenced", "short", "broken"], "prompt": prompt, "challenge": "launch_page"}
    build = client.post("/api/sites/builds", json=body).json()
    assert len(build["challenge"]["checks"]) == 4
    build = wait(client, f"/api/sites/builds/{build['id']}", lambda b: not b["running"])
    by_model = {s["model"]: s for s in build["sites"]}

    assert by_model["alpha"]["status"] == "done" and by_model["alpha"]["complete"]
    assert by_model["short"]["parts"] == 2 and by_model["short"]["complete"]  # continued after running out of tokens
    assert by_model["short"]["reasoning_tokens"] == 4 and by_model["short"]["reasoning_tokens_complete"]
    assert by_model["alpha"]["reasoning_tokens"] is None and not by_model["alpha"]["reasoning_tokens_complete"]
    assert by_model["broken"]["status"] == "error" and by_model["broken"]["bytes"] == 0

    for model in ("alpha", "fenced", "short"):
        page = client.get(f"/api/sites/builds/{build['id']}/{by_model[model]['id']}/html")
        assert page.text == sites.join_parts([page.text]) and page.text.endswith("</html>")
        assert page.text.startswith("<!doctype html>")
        csp = page.headers["content-security-policy"]
        assert csp.startswith("sandbox allow-scripts;") and "connect-src 'none'" in csp

    assert client.get(f"/api/sites/builds/{build['id']}/{by_model['broken']['id']}/html").status_code == 404

    site = by_model["alpha"]["id"]
    review = client.put(f"/api/sites/builds/{build['id']}/{site}/review", json={"stars": 4, "checks": {"0": True, "9": True}})
    assert review.json()["stars"] == 4 and review.json()["checks"] == {"0": True}
    assert client.get("/api/sites/builds").json()["builds"][0]["sites"][0]["stars"] == 4


def test_edited_prompt_is_a_custom_build_and_limits_models(client):
    body = {"models": ["alpha"], "prompt": "Make a small page about tea.", "challenge": "launch_page"}
    build = client.post("/api/sites/builds", json=body).json()
    assert build["challenge"] == {"id": "custom", "name": "Custom prompt", "difficulty": None, "checks": []}
    wait(client, f"/api/sites/builds/{build['id']}", lambda b: not b["running"])
    too_many = {"models": ["alpha", "fenced", "short", "wrong", "thinker"], "prompt": "Make a small page about tea."}
    assert client.post("/api/sites/builds", json=too_many).status_code == 422


def test_bad_ids_do_not_reach_the_disk(client):
    assert client.get("/api/sites/builds/..%2F..%2Fetc/s1/html").status_code == 404
    assert client.get("/api/sites/builds/b_00000000/s9/html").status_code == 404
    assert client.get("/api/evals/runs/..").status_code in (404, 405)


def test_only_local_same_origin_requests_are_served(client):
    for host in ("[::1]", "[::1]:8080"):
        assert client.get("/api/config", headers={"host": host}).status_code == 200
    assert client.get("/api/models?refresh=true", headers={"sec-fetch-site": "cross-site"}).status_code == 403
    assert client.get("/api/config", headers={"origin": "null"}).status_code == 403
    assert client.get("/api/config", headers={"host": "evil.example"}).status_code == 421
    cross = client.post("/api/evals/runs", json={}, headers={"origin": "https://evil.example"})
    assert cross.status_code == 403
    same = client.post("/api/evals/runs", json={}, headers={"origin": "http://localhost"})
    assert same.status_code == 422  # reaches validation
