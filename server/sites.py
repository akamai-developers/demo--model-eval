"""Websites: give several models the same prompt and keep the page each one writes.

The build runs on the server, so you can leave the page while it works. Model
output is saved as a file and only ever rendered in a sandboxed browser frame.
This process never executes it.
"""

import asyncio
import json
import logging
import re
import secrets
import shutil
import time
from functools import partial
from html.parser import HTMLParser

from . import akamai, config, site_repairs
from .storage import atomic_text, write_json

logger = logging.getLogger(__name__)

SYSTEM = (
    "Return one complete HTML document with inline CSS and JavaScript. Use no external libraries, fonts, "
    "images, or network requests. Make it responsive and keyboard accessible. Return only HTML."
)
CONTINUE = (
    "Continue the HTML from exactly where your last reply ended. Return only the remaining source, "
    "preserving any unfinished token, string or tag. Do not repeat earlier code, restart the document, "
    "add Markdown fences, or explain. Finish the document with </html>."
)
START_AFTER_REASONING = (
    "You exhausted the last output allowance before producing HTML. Start writing <!doctype html> now. "
    "Use compact markup and a simple design. Implement the core user workflows first, then cover the "
    "remaining requirements within this reply. Keep planning brief and return the working page."
)
MAX_MODELS = 4
MAX_PARTS = 3  # one reply, plus up to two continuations if the model runs out of tokens
MAX_TOKENS = 32000  # Maximum output requested per website reply.

# The frame gets an opaque origin. CSP restricts scripts and external resources.
PREVIEW_CSP = (
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' data:; "
    "style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; "
    "connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'self'"
)

BUILDS: dict[str, dict] = {}
_jobs: dict[str, list[asyncio.Task]] = {}
_challenges: list[dict] | None = None


def challenges() -> list[dict]:
    global _challenges
    if _challenges is None:
        _challenges = json.loads((config.FIXTURES / "websites.json").read_text())
    return _challenges


def _dir(build_id: str):
    if not re.fullmatch(r"b_[0-9a-f]{8}", build_id):
        raise KeyError(build_id)
    return config.DATA / "sites" / build_id


def _save(build: dict):
    write_json(_dir(build["id"]) / "build.json", build, indent=1)


def get_build(build_id: str) -> dict | None:
    if build_id in BUILDS:
        return BUILDS[build_id]
    try:
        path = _dir(build_id) / "build.json"
    except KeyError:
        return None
    if not path.exists():
        return None
    build = json.loads(path.read_text())
    for site in build["sites"]:
        site.setdefault("reasoning_tokens", None)
        site.setdefault("reasoning_tokens_complete", False)
        if site["status"] in ("queued", "writing"):
            # An interrupted stream may never have delivered its usage.
            site["status"] = "stopped"
            site["reasoning_tokens_complete"] = False
    BUILDS[build_id] = build
    return build


def list_builds(limit: int = 40) -> list[dict]:
    root = config.DATA / "sites"
    ids = {p.parent.name for p in root.glob("b_*/build.json")} | set(BUILDS)
    builds = sorted((b for b in map(get_build, ids) if b), key=lambda b: b["started"], reverse=True)
    return [
        {
            "id": b["id"],
            "started": b["started"],
            "name": b["challenge"]["name"],
            "difficulty": b["challenge"].get("difficulty"),
            "reasoning": b.get("reasoning", "off"),
            **({"repair": b["repair"]} if "repair" in b else {}),
            "sites": [{"model": s["model"], "status": s["status"], "stars": s["stars"]} for s in b["sites"]],
        }
        for b in builds[:limit]
    ]


def html_path(build_id: str, site_id: str):
    if not re.fullmatch(r"s[1-4]", site_id):
        raise KeyError(site_id)
    return _dir(build_id) / f"{site_id}.html"


class _DocumentBounds(HTMLParser):
    """Locate document tags without rebuilding or executing the generated source."""

    # Older Python versions only treat script and style as raw text.
    CDATA_CONTENT_ELEMENTS = ("script", "style", "textarea", "title", "iframe", "xmp", "noembed", "noframes", "noscript")

    def __init__(self, source: str):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.line_starts = [0] + [match.end() for match in re.finditer("\n", source)]
        self.start = None
        self.end = None
        self.template_depth = 0

    def _offset(self):
        line, column = self.getpos()
        return self.line_starts[line - 1] + column

    def handle_decl(self, decl):
        if self.start is None and not self.template_depth and re.match(r"doctype\s+html\b", decl, re.I):
            self.start = self._offset()
            self.end = None

    def handle_starttag(self, tag, attrs):
        if tag == "template":
            self.template_depth += 1
        elif tag == "html" and self.start is None and not self.template_depth:
            self.start = self._offset()
            self.end = None

    def handle_endtag(self, tag):
        if tag == "template":
            self.template_depth = max(0, self.template_depth - 1)
        elif tag == "html" and self.start is not None and not self.template_depth and self.end is None:
            offset = self._offset()
            if self.source.startswith("</", offset):
                self.end = self.source.index(">", offset) + 1


def _extract_page(parts: list[str]) -> tuple[str, bool]:
    cleaned = []
    for text in parts:
        text = re.sub(r"^\s*```(?:html)?[ \t]*\r?\n", "", text, flags=re.I)
        cleaned.append(re.sub(r"\r?\n```\s*$", "", text))
    html = "".join(cleaned).strip()
    bounds = _DocumentBounds(html)
    try:
        bounds.feed(html)
    except (ValueError, AssertionError):
        # Some Python versions reject malformed declarations. Keep the source for review.
        return html[bounds.start:], False
    return html[bounds.start:bounds.end], bounds.end is not None


def join_parts(parts: list[str]) -> str:
    """Join continuations and remove surrounding model commentary when the tags delimit a page."""
    return _extract_page(parts)[0]


async def _build_site(build: dict, site: dict, max_tokens: int, source: str | None = None):
    parts: list[str] = []
    current: list[str] = []
    html, complete = "", False

    def on_delta(event):
        site["thinking_chars"] += len(event["reasoning"])
        if event["content"]:
            current.append(event["content"])
            site["chars"] += len(event["content"])
            site["tail"] = (site["tail"] + event["content"])[-1600:]

    async def request(messages: list[dict], budget: int):
        nonlocal max_tokens
        budget = min(budget, max_tokens)
        body = akamai.request_body(site["model"], messages, max_tokens=budget, reasoning=build["reasoning"])
        all_previous_reported = site["parts"] == 0 or site["reasoning_tokens_complete"]
        site["reasoning_tokens_complete"] = False
        reply = await akamai.complete(body, on_delta=on_delta, retries=3)
        # Learn a smaller limit only if the provider rejects this real build's budget.
        if reply.get("status") == 400 and not reply.get("content") and not reply.get("reasoning"):
            limit = re.search(r"model limit \(([0-9]{1,9})\)", reply.get("error", ""))
            if limit and 0 < int(limit[1]) < budget:
                max_tokens = int(limit[1])
                reply = await akamai.complete({**body, "max_tokens": max_tokens}, on_delta=on_delta, retries=3)
        current.clear()
        site["parts"] += 1
        site["completion_tokens"] += reply.get("completion_tokens") or 0
        if (reported := reply.get("reasoning_tokens")) is not None:
            site["reasoning_tokens"] = (site["reasoning_tokens"] or 0) + reported
            site["reasoning_tokens_complete"] = all_previous_reported
        site["finish_reason"] = reply.get("finish_reason")
        site["ttft_ms"] = site["ttft_ms"] or reply.get("ttft_ms")
        site["tokens_per_second"] = reply.get("tokens_per_second") or site["tokens_per_second"]
        return reply

    site["status"] = "writing"
    site["started"] = time.time()
    try:
        if source is None:
            messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": build["prompt"]}]
            for _ in range(MAX_PARTS):
                reply = await request(messages, max_tokens)
                parts.append(reply["content"])
                if reply.get("error"):
                    site["error"] = reply["error"]
                    break
                if reply.get("finish_reason") != "length":
                    break
                if reply["content"].strip():
                    messages = [*messages, {"role": "assistant", "content": reply["content"]}, {"role": "user", "content": CONTINUE}]
                elif len(messages) == 2:
                    messages = [messages[0], {"role": "user", "content": build["prompt"] + "\n\n" + START_AFTER_REASONING}]
                elif reply["content"]:
                    # Carry a whitespace-only fragment forward without inserting an empty assistant turn.
                    messages = [*messages[:-2], {"role": "assistant", "content": messages[-2]["content"] + reply["content"]}, messages[-1]]
        else:
            html, site["error"] = await site_repairs.repair_page(build, source, max_tokens, request, _extract_page)
            complete = bool(html)
        site["status"] = "error" if site["error"] else "done"
    except asyncio.CancelledError:
        site["status"] = "stopped"
    except Exception:
        logger.exception("Generation failed for %s/%s", build["id"], site["id"])
        site["status"], site["error"] = "error", "Generation failed while receiving the model reply."
    finally:
        if current:
            site["parts"] += 1
        if source is None:
            html, complete = _extract_page([*parts, "".join(current)])
        site["total_ms"] = round((time.time() - site["started"]) * 1000)
        site["tail"] = ""
        if html:
            try:
                with atomic_text(html_path(build["id"], site["id"])) as output:
                    output.write(html)
                    size = output.tell()
                site["bytes"] = size
                site["complete"] = complete
            except (OSError, UnicodeError):
                logger.exception("Saving HTML failed for %s/%s", build["id"], site["id"])
                site["status"], site["error"] = "error", "Could not save the generated HTML."
        elif site["status"] == "done":
            site["status"], site["error"] = "error", "The model returned no HTML."
            if site["finish_reason"] == "length" and site["thinking_chars"]:
                site["error"] = f"The model exhausted {site['parts']} output allowances while reasoning and returned no HTML."
        _save(build)


def _site_finished(build: dict, site: dict, job: asyncio.Task):
    jobs = _jobs[build["id"]]
    jobs.remove(job)
    if not jobs:
        _jobs.pop(build["id"])
    if job.cancelled():  # cancellation before the coroutine could enter its try block
        site["status"] = "stopped"
        _save(build)
    elif (exc := job.exception()) is not None:
        logger.error("Finalizing %s/%s failed", build["id"], site["id"], exc_info=exc)
        site["status"], site["error"] = "error", "Could not save the build."


def start_build(models: list[dict], prompt: str, challenge_id: str | None, reasoning: str = "off") -> dict:
    """Queue a website for each selected catalog model."""
    if not 1 <= len(models) <= MAX_MODELS:
        raise ValueError(f"Choose between 1 and {MAX_MODELS} models.")
    prompt = prompt.strip()
    if not 10 <= len(prompt) <= 12000:
        raise ValueError("Write a prompt between 10 and 12,000 characters.")
    if reasoning not in ("off", "default", "on"):
        raise ValueError("reasoning must be off, default or on.")
    preset = next((c for c in challenges() if c["id"] == challenge_id), None)
    # Acceptance checks belong to the stock prompt. An edited prompt is a custom page.
    if preset and preset["prompt"].strip() == prompt:
        challenge = {k: preset[k] for k in ("id", "name", "difficulty", "checks")}
    else:
        challenge = {"id": "custom", "name": "Custom prompt", "difficulty": None, "checks": []}
    return _queue_build(models, prompt, challenge, reasoning)


def start_repair(build_id: str, site_id: str, model: dict, feedback: str, reasoning: str) -> dict:
    parent = get_build(build_id)
    previous = next((s for s in parent["sites"] if s["id"] == site_id), None) if parent else None
    if previous is None:
        raise KeyError("No such page")
    if previous["model"] != model["id"]:
        raise ValueError("The repair must use the source page's model.")
    if previous["status"] in ("queued", "writing"):
        raise ValueError("Wait for the page to finish before repairing it.")
    feedback = feedback.strip()
    if not 1 <= len(feedback) <= 2000 or reasoning not in ("on", "off"):
        raise ValueError("Provide browser feedback (1–2,000 characters) and choose reasoning on or off.")
    try:
        source = html_path(build_id, site_id).read_bytes().decode("utf-8")
    except FileNotFoundError:
        raise KeyError("No page was saved for this model") from None
    if not source.strip():
        raise ValueError("The saved page is empty.")
    repair = {"build_id": build_id, "site_id": site_id, "feedback": feedback}
    return _queue_build([model], parent["prompt"], parent["challenge"], reasoning, repair=repair, source=source)


def _queue_build(models, prompt, challenge, reasoning, *, repair=None, source=None):
    build_id = "b_" + secrets.token_hex(4)
    while _dir(build_id).exists() or build_id in BUILDS:
        build_id = "b_" + secrets.token_hex(4)
    build = {
        "id": build_id,
        "started": time.time(),
        "challenge": challenge,
        "prompt": prompt,
        "reasoning": reasoning,
        "sites": [
            {
                "id": f"s{n}", "model": m["id"], "status": "queued", "started": None,
                "chars": 0, "thinking_chars": 0, "tail": "", "parts": 0, "bytes": 0, "complete": False,
                "ttft_ms": None, "total_ms": None, "completion_tokens": 0, "tokens_per_second": None,
                "reasoning_tokens": None, "reasoning_tokens_complete": False,
                "finish_reason": None, "error": None, "stars": 0, "checks": {}, "notes": "",
            }
            for n, m in enumerate(models, 1)
        ],
    }
    if repair:
        build["repair"] = repair
    _save(build)
    BUILDS[build["id"]] = build
    jobs = []
    _jobs[build["id"]] = jobs
    for site, model in zip(build["sites"], models):
        budget = min(model.get("max_output_tokens") or MAX_TOKENS, MAX_TOKENS)
        job = asyncio.create_task(_build_site(build, site, budget, source))
        job.add_done_callback(partial(_site_finished, build, site))
        jobs.append(job)
    return build


def stop_build(build_id: str) -> bool:
    jobs = _jobs.get(build_id, [])
    for job in jobs:
        job.cancel()
    return bool(jobs)


def review(build_id: str, site_id: str, stars: int | None, checks: dict | None, notes: str | None) -> dict | None:
    build = get_build(build_id)
    site = next((s for s in build["sites"] if s["id"] == site_id), None) if build else None
    if not site:
        return None
    changes = {}
    if stars is not None:
        changes["stars"] = max(0, min(5, int(stars)))
    if checks is not None:
        valid_keys = {str(i) for i in range(len(build["challenge"]["checks"]))}
        changes["checks"] = {k: bool(v) for k, v in checks.items() if k in valid_keys}
    if notes is not None:
        changes["notes"] = str(notes)[:2000]
    _save(build | {"sites": [s | changes if s is site else s for s in build["sites"]]})
    site.update(changes)
    return site


def delete_build(build_id: str) -> bool:
    if not get_build(build_id) or build_id in _jobs:
        return False
    shutil.rmtree(_dir(build_id))
    BUILDS.pop(build_id, None)
    return True
