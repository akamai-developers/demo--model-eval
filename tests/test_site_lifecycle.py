import asyncio
import json

import pytest

from server import akamai, config, evals, sites
from server.app import create_app
from server.storage import write_json


@pytest.fixture
def isolated_builds(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA", tmp_path)
    monkeypatch.setattr(sites, "BUILDS", {})
    monkeypatch.setattr(sites, "_jobs", {})


def start():
    return sites.start_build([{"id": "alpha"}], "Make a page about tea.", None)


def test_stop_before_site_task_starts(isolated_builds):
    async def run():
        build = start()
        jobs = list(sites._jobs[build["id"]])
        assert sites.stop_build(build["id"])
        await asyncio.gather(*jobs, return_exceptions=True)
        assert build["id"] not in sites._jobs
        sites.BUILDS.clear()
        saved = json.loads((config.DATA / "sites" / build["id"] / "build.json").read_text())
        assert saved["sites"][0]["status"] == "stopped"

    asyncio.run(run())


def test_unexpected_error_preserves_partial_html(isolated_builds, monkeypatch):
    async def fail(body, on_delta, retries):
        on_delta({"content": "<html>partial", "reasoning": ""})
        raise ValueError("unexpected response")

    async def run():
        build = start()
        await asyncio.gather(*sites._jobs[build["id"]])
        site = build["sites"][0]
        assert site["status"] == "error" and site["error"]
        assert site["parts"] == 1 and not site["complete"]
        assert sites.html_path(build["id"], site["id"]).read_text() == "<html>partial"

    monkeypatch.setattr(akamai, "complete", fail)
    asyncio.run(run())


def test_cancelled_repair_never_publishes_incomplete_edit_json(isolated_builds, monkeypatch):
    async def run():
        source = "<html>Hello</html>"
        async def generate(body, on_delta, retries):
            return {"content": source}

        monkeypatch.setattr(akamai, "complete", generate)
        parent = start()
        await asyncio.gather(*sites._jobs[parent["id"]])
        streaming = asyncio.Event()
        async def editing(body, on_delta, retries):
            on_delta({"content": '{"edits":[', "reasoning": ""})
            streaming.set()
            await asyncio.Event().wait()

        monkeypatch.setattr(akamai, "complete", editing)
        build = sites.start_repair(parent["id"], "s1", {"id": "alpha"}, "Heading is wrong", "on")
        jobs = list(sites._jobs[build["id"]])
        await asyncio.wait_for(streaming.wait(), timeout=2)
        sites.stop_build(build["id"])
        await asyncio.gather(*jobs)
        assert build["sites"][0]["status"] == "stopped" and build["sites"][0]["bytes"] == 0
        assert not sites.html_path(build["id"], "s1").exists()
        assert sites.html_path(parent["id"], "s1").read_text() == source

    asyncio.run(run())


@pytest.mark.parametrize("fragment", [
    '<script>const example = "</html>";\nupdatePreview(example);',
    '<script>const page = "</html>',
    '<textarea></html></textarea>still editing',
    '<!-- </html> -->more source',
    '<div title="</html>">more source',
    '<template><html></html></template>more source',
])
def test_partial_source_keeps_embedded_html_tags(fragment, isolated_builds, monkeypatch):
    source = "<!doctype html>\n<html>\n" + fragment

    async def incomplete(body, on_delta, retries):
        on_delta({"content": source, "reasoning": ""})
        return {"content": source, "finish_reason": "stop"}

    async def run():
        build = start()
        await asyncio.gather(*sites._jobs[build["id"]])
        site = build["sites"][0]
        assert not site["complete"]
        assert sites.html_path(build["id"], site["id"]).read_text() == source

    monkeypatch.setattr(akamai, "complete", incomplete)
    asyncio.run(run())


def test_closing_tag_in_prose_does_not_complete_or_truncate_a_website(isolated_builds, monkeypatch):
    source = "The document should end with </html>. Here is the partial source."

    async def generate(body, on_delta, retries):
        return {"content": source, "finish_reason": "stop"}

    async def run():
        build = start()
        await asyncio.gather(*sites._jobs[build["id"]])
        site, = build["sites"]
        assert not site["complete"]
        assert sites.html_path(build["id"], site["id"]).read_text() == source

    monkeypatch.setattr(akamai, "complete", generate)
    asyncio.run(run())


def test_real_closing_tag_after_split_script_ends_document():
    page = '<!doctype html>\n<html><script>const inner = "</html>";</script></HTML >'
    split = page.index("</html>") + 3
    assert sites.join_parts(["Here is the page:\n" + page[:split], page[split:] + "\nDone."]) == page


@pytest.mark.parametrize("eventual_html", [True, False])
def test_reasoning_only_website_gets_a_clean_start_or_reports_exhaustion(isolated_builds, monkeypatch, eventual_html):
    requests = []
    async def generate(body, on_delta, retries):
        requests.append(body)
        ready = eventual_html and len(requests) == 2
        visible = "<html>Ready</html>" if ready else " "
        on_delta({"content": visible, "reasoning": "think"})
        return {"content": visible, "finish_reason": "stop" if ready else "length",
                "completion_tokens": 23, "reasoning_tokens": 7 if ready else 23}

    monkeypatch.setattr(akamai, "complete", generate)
    async def run():
        build = sites.start_build([{"id": "alpha"}], "Make a functioning page.", None, "on")
        await asyncio.gather(*sites._jobs[build["id"]])
        site, = build["sites"]
        assert len(requests) == (2 if eventual_html else sites.MAX_PARTS)
        for body in requests:
            assert body["chat_template_kwargs"]["enable_thinking"] and len(body["messages"]) == 2
            assert build["prompt"] in body["messages"][1]["content"]
        assert "core user workflows" in requests[1]["messages"][1]["content"]
        assert site["completion_tokens"] == 23 * len(requests)
        assert site["reasoning_tokens"] == (30 if eventual_html else 23 * sites.MAX_PARTS)
        assert site["reasoning_tokens_complete"]
        if eventual_html:
            assert site["status"] == "done" and site["complete"]
            assert sites.html_path(build["id"], "s1").read_text() == "<html>Ready</html>"
        else:
            assert site["status"] == "error" and "reasoning" in site["error"] and "no HTML" in site["error"]
            assert not sites.html_path(build["id"], "s1").exists()

    asyncio.run(run())


@pytest.mark.parametrize(("counts", "total", "complete"), [
    ([0, 0], 0, True),
    ([None, None], None, False),
    ([None, 0], 0, False),
    ([None, 7], 7, False),
    ([4, None], 4, False),
])
def test_missing_reasoning_usage_does_not_imply_zero(isolated_builds, monkeypatch, counts, total, complete):
    replies = iter(zip(["<html>", "</html>"], counts, ["length", "stop"]))

    async def generate(body, on_delta, retries):
        fragment, count, finish = next(replies)
        result = {"content": fragment, "finish_reason": finish, "completion_tokens": 20}
        if count is not None:
            result["reasoning_tokens"] = count
        return result

    monkeypatch.setattr(akamai, "complete", generate)
    async def run():
        build = start()
        await asyncio.gather(*sites._jobs[build["id"]])
        sites.BUILDS.clear()
        site, = sites.get_build(build["id"])["sites"]
        assert site["reasoning_tokens"] == total
        assert site["reasoning_tokens_complete"] is complete
        assert site["completion_tokens"] == 40

    asyncio.run(run())


def test_interrupted_reasoning_stream_keeps_prior_count_as_partial(isolated_builds, monkeypatch):
    async def run():
        streaming = asyncio.Event()
        async def generate(body, on_delta, retries):
            on_delta({"reasoning": "thinking", "content": ""})
            if len(body["messages"]) == 2:
                return {"content": "<html>", "reasoning_tokens": 4, "finish_reason": "length"}
            streaming.set()
            await asyncio.Event().wait()

        monkeypatch.setattr(akamai, "complete", generate)
        build = start()
        jobs = list(sites._jobs[build["id"]])
        await asyncio.wait_for(streaming.wait(), timeout=2)
        assert build["sites"][0]["reasoning_tokens"] == 4
        assert not build["sites"][0]["reasoning_tokens_complete"]
        sites.stop_build(build["id"])
        await asyncio.gather(*jobs)
        sites.BUILDS.clear()
        site, = sites.get_build(build["id"])["sites"]
        assert site["status"] == "stopped" and site["reasoning_tokens"] == 4
        assert not site["reasoning_tokens_complete"]

    asyncio.run(run())


def test_historical_build_without_reasoning_usage_is_unknown(isolated_builds):
    path = config.DATA / "sites" / "b_12345678" / "build.json"
    write_json(path, {"id": "b_12345678", "sites": [{"status": "done", "thinking_chars": 400}]})
    site, = sites.get_build("b_12345678")["sites"]
    assert site["reasoning_tokens"] is None and not site["reasoning_tokens_complete"]


def test_whitespace_only_continuation_keeps_the_last_visible_source(isolated_builds, monkeypatch):
    requests = []
    chunks = iter(["<html>Hello", " ", "world</html>"])
    async def generate(body, on_delta, retries):
        requests.append(body)
        chunk = next(chunks)
        return {"content": chunk, "finish_reason": "stop" if len(requests) == 3 else "length"}

    monkeypatch.setattr(akamai, "complete", generate)
    async def run():
        build = start()
        await asyncio.gather(*sites._jobs[build["id"]])
        assert requests[2]["messages"][-2] == {"role": "assistant", "content": "<html>Hello "}
        assert len(requests[2]["messages"]) == 4
        assert sites.html_path(build["id"], "s1").read_text() == "<html>Hello world</html>"

    asyncio.run(run())


def test_shutdown_saves_running_site_and_waits_for_eval(isolated_builds, monkeypatch):
    async def run():
        ready = asyncio.Event()
        calls = 0
        cleaned = []

        async def generate(body, on_delta=None, retries=5):
            nonlocal calls
            calls += 1
            if on_delta:
                on_delta({"content": "<html>stop", "reasoning": ""})
            if calls == 2:
                ready.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0)
                cleaned.append(not akamai.client.is_closed)

        monkeypatch.setattr(akamai, "complete", generate)
        monkeypatch.setattr(evals, "RUNS", {})
        monkeypatch.setattr(evals, "_jobs", {})
        app = create_app()
        async with app.router.lifespan_context(app):
            build = start()
            run = evals.start_run(["alpha"], ["sentiment"], limit=1)
            await asyncio.wait_for(ready.wait(), timeout=2)
        assert cleaned == [True, True] and akamai.client.is_closed
        assert run["status"] == "stopped" and build["sites"][0]["status"] == "stopped"
        assert not sites._jobs and not evals._jobs
        assert sites.html_path(build["id"], "s1").read_text() == "<html>stop"

    asyncio.run(run())


def test_failed_json_write_keeps_previous_build_metadata(tmp_path):
    path = tmp_path / "build.json"
    write_json(path, {"status": "queued"})
    with pytest.raises(TypeError):
        write_json(path, {"bad": object()})
    assert json.loads(path.read_text()) == {"status": "queued"}
    assert list(tmp_path.iterdir()) == [path]


def test_review_accepts_only_canonical_check_indices(isolated_builds):
    build = {"id": "b_fedcba98", "challenge": {"checks": ["One check"]}, "sites": [{"id": "s1"}]}
    sites.BUILDS[build["id"]] = build
    site = sites.review(build["id"], "s1", None, {"0": True, "00": True, "²": True, "9" * 5000: True}, None)
    assert site["checks"] == {"0": True}


def test_review_save_failure_keeps_previous_rating(isolated_builds, monkeypatch):
    build = {"id": "b_fedcba98", "sites": [{"id": "s1", "stars": 2}]}
    sites.BUILDS[build["id"]] = build

    def fail_save(_build):
        raise OSError("disk full")

    monkeypatch.setattr(sites, "_save", fail_save)
    with pytest.raises(OSError):
        sites.review(build["id"], "s1", 5, None, None)
    assert sites.get_build(build["id"])["sites"][0]["stars"] == 2
