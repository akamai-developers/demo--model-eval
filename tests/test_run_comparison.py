from server import evals


def test_history_and_comparison_use_only_matching_observations(client):
    def result(example, output, passed, *, model="alpha", expected="yes", time_ms=15):
        return {"model": model, "task": "t", "example": example, "input": example,
                "expected": expected, "output": output, "passed": passed, "total_ms": time_ms,
                "completion_tokens": 8}

    def saved(run_id, mode, models, results):
        run = {"id": run_id, "started": 1, "status": "stopped", "models": models, "done": len(results),
               "total": 10, "tasks": [{"id": "t", "name": "Task", "grader": "exact", "examples": 5}],
               "results": results}
        if mode is not None:
            run["reasoning"] = mode
        evals.RUNS[run_id] = run
        return run_id

    a = saved("r_11111111", "off", ["alpha"], [
        result("one", "no", False), result("two", "yes", True), result("three", "yes", True),
    ])
    b = saved("r_22222222", "on", ["alpha", "beta"], [
        result("two", "no", False), result("one", "yes", True), result("three", "no", True, expected="no"),
        result("four", "yes", True, model="beta"),
    ])
    old = saved("r_33333333", None, ["alpha"], [])
    history = client.get("/api/evals/runs").json()["runs"]
    assert {r["id"]: r["reasoning"] for r in history} == {a: "off", b: "on", old: None}
    rows = client.get(f"/api/evals/runs/{b}/compare/{a}").json()["rows"]
    alpha, beta = rows
    assert alpha["shared"] == 2 and alpha["baseline_done"] == alpha["selected_done"] == 3
    assert alpha["improved"] == alpha["regressed"] == 1
    assert alpha["baseline"] == alpha["selected"] == {"passed": 1, "tokens": 16, "median_ms": 15}
    assert beta["shared"] == 0 and beta["selected_done"] == 1 and beta["baseline"]["tokens"] is None
    assert client.get(f"/api/evals/runs/{a}/compare/{a}").status_code == 422
    assert client.get(f"/api/evals/runs/{b}/compare/r_00000000").status_code == 404
