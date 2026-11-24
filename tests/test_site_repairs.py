import asyncio
import json

import pytest

from server import akamai, site_diagnostics, site_repairs, sites
from tests.conftest import PAGE
from tests.test_api import wait


def proposal(old, new):
    return json.dumps({"edits": [{"old": old, "new": new}]})


@pytest.mark.parametrize("reasoning,enabled", [("on", True), ("off", False)])
def test_repair_forks_reviewed_page_uses_selected_reasoning_and_reloads(client, monkeypatch, reasoning, enabled):
    preset = sites.challenges()[0]
    parent = client.post("/api/sites/builds", json={
        "models": ["alpha"], "prompt": preset["prompt"], "challenge": preset["id"], "reasoning": "off",
    }).json()
    url = f"/api/sites/builds/{parent['id']}"
    wait(client, url, lambda b: not b["running"])
    client.put(url + "/s1/review", json={"stars": 2, "checks": {"0": True}, "notes": "Original"})
    before = client.get(url).json()
    issues = []

    async def syntax_feedback(source):
        return "HTML line 4: SyntaxError: fixture" if source == PAGE else ""

    async def edit(body, on_delta, retries):
        issues.append(body)
        text = proposal("Hello", "Ready")
        on_delta({"content": "", "reasoning": "test" if enabled else ""})
        on_delta({"content": text, "reasoning": ""})
        return {"content": text, "completion_tokens": 11, "reasoning_tokens": 4 if enabled else 0, "finish_reason": "stop"}

    monkeypatch.setattr(site_diagnostics, "syntax_feedback", syntax_feedback)
    monkeypatch.setattr(akamai, "complete", edit)
    repaired = client.post(url + "/s1/repair", json={"feedback": "  Heading should say Ready  ", "reasoning": reasoning}).json()
    assert repaired["id"] != parent["id"]
    new_url = f"/api/sites/builds/{repaired['id']}"
    repaired = wait(client, new_url, lambda b: not b["running"])
    assert len(issues) == 1
    assert issues[0]["model"] == "alpha" and issues[0]["chat_template_kwargs"]["enable_thinking"] is enabled
    prompt = issues[0]["messages"][1]["content"]
    assert PAGE in prompt and "Heading should say Ready" in prompt and preset["prompt"] in prompt
    assert "HTML line 4" in prompt
    assert repaired["challenge"] == before["challenge"] and repaired["prompt"] == before["prompt"]
    assert repaired["repair"] == {"build_id": parent["id"], "site_id": "s1", "feedback": "Heading should say Ready"}
    site, = repaired["sites"]
    assert site["status"] == "done" and site["complete"] and site["completion_tokens"] == 11
    assert site["reasoning_tokens_complete"] and site["reasoning_tokens"] == (4 if enabled else 0)
    assert site["stars"] == 0 and site["checks"] == {} and site["notes"] == ""
    assert client.get(new_url + "/s1/html").text == PAGE.replace("Hello", "Ready")
    assert client.get(url).json() == before and client.get(url + "/s1/html").text == PAGE
    sites.BUILDS.clear()
    summary = client.get("/api/sites/builds").json()["builds"][0]
    assert summary["repair"] == repaired["repair"] and summary["reasoning"] == reasoning


def test_site_repair_rejects_invalid_inputs(client):
    url = "/api/sites/builds/b_00000000/s1/repair"
    assert client.post(url, json={"feedback": "Blank", "reasoning": "on"}).status_code == 404
    assert client.post(url, json={"feedback": "", "reasoning": "on"}).status_code == 422
    assert client.post(url, json={"feedback": "   ", "reasoning": "off"}).status_code == 422
    assert client.post(url, json={"feedback": "Blank", "reasoning": "default"}).status_code == 422


@pytest.mark.parametrize("source,edits,message", [
    ("aaa", [{"old": "aa", "new": "X"}], "multiple"),
    ("abcd", [{"old": "abc", "new": "X"}, {"old": "cd", "new": "Z"}], "overlap"),
    ("abc", [{"old": "x", "new": "y"}], "absent"),
    ("abc", [{"old": "a", "new": "a"}], "different"),
    ("abc", [{"old": "abc", "new": 1}], "string"),
])
def test_patch_anchors_are_unambiguous_and_atomic(source, edits, message):
    with pytest.raises(ValueError, match=message):
        site_repairs.apply_edits(source, json.dumps({"edits": edits}))


def test_matched_edits_are_relative_to_original():
    edits = [{"old": "b", "new": "c"}, {"old": "a", "new": "b"}]
    assert site_repairs.apply_edits("ab", json.dumps({"edits": edits})) == "bc"


def run_repair(source, replies, feedback="The visible heading is wrong."):
    requests = []
    async def request(messages, budget):
        requests.append((messages, budget))
        return replies[len(requests) - 1]
    result = asyncio.run(site_repairs.repair_page(
        {"prompt": "Make a website", "repair": {"feedback": feedback}}, source, 32000, request, sites._extract_page,
    ))
    return result, requests


def test_repair_continues_json_and_corrects_mismatched_anchor():
    page = "<html>Hello</html>"
    patch = proposal("Hello", "Ready")
    result, requests = run_repair(page, [
        {"content": proposal("Wrong", "Ready")},
        {"content": patch[:13], "finish_reason": "length"},
        {"content": patch[13:], "finish_reason": "stop"},
    ])
    assert result == ("<html>Ready</html>", None)
    assert "absent" in requests[1][0][-1]["content"]
    assert requests[2][0][-2] == {"role": "assistant", "content": patch[:13]}
    assert requests[2][1] > requests[1][1]


def test_reasoning_only_length_restarts_with_room_for_visible_edits():
    page = "<html>Start</html>"
    result, requests = run_repair(page, [
        {"content": "", "reasoning": "out of room", "finish_reason": "length"},
        {"content": proposal("Start", "Ready")},
    ])
    assert result == ("<html>Ready</html>", None)
    messages, budget = requests[1]
    assert budget == requests[0][1] * 2
    assert [m["role"] for m in messages] == ["system", "user"]
    assert page in messages[1]["content"] and "out of room" not in messages[1]["content"]


def test_repair_handles_input_context_and_repeated_bad_replies():
    page = "<html>" + "." * 300 + "Label" + "." * 300 + "</html>"
    result, requests = run_repair(page, [
        {"error": "maximum context length exceeded", "status": 400},
        {"content": proposal("Label", "Ready")},
    ], "Heading 'Label' should say Ready")
    assert result == (page.replace("Label", "Ready"), None)
    assert "Excerpt" in requests[1][0][1]["content"] and page not in requests[1][0][1]["content"]
    result, requests = run_repair(page, [{"content": "invalid"}] * 3)
    assert len(requests) == 3 and result[0] == "" and "JSON" in result[1]


def test_diagnostic_focus_on_large_source_expands_but_validates_global_uniqueness(monkeypatch):
    async def diagnose(page):
        return "HTML line 4: SyntaxError: urgent" if "urgent" in page else ""
    monkeypatch.setattr(site_diagnostics, "syntax_feedback", diagnose)
    page = "<html>label\n" + "." * 26000 + "\n<script>\nlabel urgent\n</script>\n" + "." * 26000 + "</html>"
    result, requests = run_repair(page, [{"content": proposal("label", "x")}, {"content": proposal("label urgent", "ready")}])
    first = requests[0][0][1]["content"]
    second = requests[1][0][1]["content"]
    assert "Excerpt" in first and "label urgent" in first and not page in first
    assert "multiple times" in second and len(second) > len(first)
    assert result == (page.replace("label urgent", "ready"), None)


def test_repair_follows_up_on_new_syntax_error_and_retains_last_applied_edits(monkeypatch):
    async def diagnose(page):
        return "HTML line 3: Bad JavaScript" if "pending" in page else ""

    monkeypatch.setattr(site_diagnostics, "syntax_feedback", diagnose)
    page = "<html>Start</html>"
    result, requests = run_repair(page, [{"content": proposal("Start", "pending")}, {"content": proposal("pending", "Ready")}])
    assert result == ("<html>Ready</html>", None)
    assert "HTML line 3" in requests[1][0][1]["content"] and "<html>pending</html>" in requests[1][0][1]["content"]
    result, requests = run_repair(page, [{"content": proposal("Start", "pending")}, {"error": "server unavailable", "status": 503}])
    assert result[0] == "<html>pending</html>" and "server unavailable" in result[1]
