"""The web app: a JSON API under /api and the built frontend for everything else.

Run it with `make start`. It binds to 127.0.0.1. The API key stays in this
process and is never sent to the browser.
"""

import asyncio
import base64
import json
import re
from contextlib import asynccontextmanager
from typing import Annotated, Literal

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field, StringConstraints

from . import akamai, config, evals, sites

Reasoning = Literal["default", "on", "off"]
LOCAL_HOST = re.compile(r"(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?", re.IGNORECASE)
CHAT_BODY_LIMIT = 64 * 1024 * 1024  # Includes base64 images from earlier conversation turns.
API_BODY_LIMIT = 4 * 1024 * 1024
APP_HEADERS = {
    "Cache-Control": "no-cache",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; frame-src 'self'; "
        "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"
    ),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


class Guard:
    """Only answer requests a browser on this machine sent to this app.

    The Host check stops DNS rebinding. The Origin check stops another site's
    page from posting here and spending your tokens.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
            host = headers.get("host", "")
            if not LOCAL_HOST.fullmatch(host):
                return await PlainTextResponse("Open this app at http://localhost", 421)(scope, receive, send)
            origin = headers.get("origin")
            if scope["path"].startswith("/api/"):
                # Browsers include Fetch Metadata even for cross-origin reads without an Origin header.
                foreign_site = headers.get("sec-fetch-site") in {"cross-site", "same-site"}
                foreign_origin = origin is not None and origin.lower() != f"{scope['scheme']}://{host}".lower()
                if foreign_site or foreign_origin:
                    return await PlainTextResponse("Cross-site request refused", 403)(scope, receive, send)
                if scope["method"] in {"POST", "PUT", "PATCH"}:
                    is_chat = scope["path"] == "/api/chat"
                    limit = CHAT_BODY_LIMIT if is_chat else API_BODY_LIMIT
                    detail = ("Conversation exceeds 64 MiB. Start a new session or use smaller attachments."
                              if is_chat else "Request exceeds 4 MiB. Reduce its size and try again.")
                    length = headers.get("content-length")
                    if length and length.isascii() and length.isdecimal() and (len(length) > 20 or int(length) > limit):
                        return await JSONResponse({"detail": detail}, 413)(scope, receive, send)
                    upstream_receive = receive
                    received = 0

                    async def limited_receive():
                        nonlocal received
                        message = await upstream_receive()
                        received += len(message.get("body", b""))
                        if received > limit:
                            raise HTTPException(413, detail)
                        return message

                    receive = limited_receive
        await self.app(scope, receive, send)


class TextPart(BaseModel):
    type: Literal["text"]
    text: str


class ImageURL(BaseModel):
    url: str


class ImagePart(BaseModel):
    type: Literal["image_url"]
    image_url: ImageURL


ContentPart = Annotated[TextPart | ImagePart, Field(discriminator="type")]


class UserMessage(BaseModel):
    role: Literal["user"]
    content: str | Annotated[list[ContentPart], Field(min_length=1)]


class AssistantMessage(BaseModel):
    role: Literal["assistant"]
    content: str


Message = Annotated[UserMessage | AssistantMessage, Field(discriminator="role")]

IMAGE_LIMIT = 4 * 1024 * 1024
TURN_IMAGE_LIMIT = 8 * 1024 * 1024


def validate_images(message: UserMessage) -> None:
    if isinstance(message.content, str):
        return
    images = [part.image_url.url for part in message.content if isinstance(part, ImagePart)]
    if len(images) > 4:
        raise HTTPException(422, "Attach up to four images per message.")
    total = 0
    for url in images:
        header, _, encoded = url.partition(",")
        if header not in ("data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"):
            raise HTTPException(422, "Attach a local PNG, JPEG, or WebP image.")
        if len(encoded) > 4 * ((IMAGE_LIMIT + 2) // 3):
            raise HTTPException(422, "Each image must be 4 MiB or smaller.")
        try:
            data = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise HTTPException(422, "The image contains invalid base64 data.") from None
        if len(data) > IMAGE_LIMIT:
            raise HTTPException(422, "Each image must be 4 MiB or smaller.")
        matches_type = {
            "data:image/png;base64": data.startswith(b"\x89PNG\r\n\x1a\n"),
            "data:image/jpeg;base64": data.startswith(b"\xff\xd8\xff"),
            "data:image/webp;base64": data.startswith(b"RIFF") and data[8:12] == b"WEBP",
        }
        if not matches_type[header]:
            raise HTTPException(422, "The image data does not match its declared file type.")
        total += len(data)
        if total > TURN_IMAGE_LIMIT:
            raise HTTPException(422, "Images in one message must total 8 MiB or less.")


class ChatRequest(BaseModel):
    model: str
    messages: list[Message] = Field(min_length=1)
    system: str = ""
    max_tokens: int = Field(1024, ge=1, le=1_048_576)
    temperature: float | None = Field(None, ge=0, le=2)
    top_p: float | None = Field(None, gt=0, le=1)
    reasoning: Reasoning = "default"


class RunRequest(BaseModel):
    models: list[str] = Field(min_length=1)
    tasks: list[str] = Field(min_length=1)
    reasoning: Reasoning = "off"
    limit: int | None = Field(None, ge=1, le=50)


class BuildRequest(BaseModel):
    models: list[str] = Field(min_length=1, max_length=sites.MAX_MODELS)
    prompt: str
    challenge: str | None = None
    # Off by default. A thinking model can reason for minutes before it writes a line of HTML.
    reasoning: Reasoning = "off"


class ReviewRequest(BaseModel):
    stars: int | None = Field(None, ge=0, le=5)
    checks: dict[str, bool] | None = None
    notes: str | None = None


class RepairRequest(BaseModel):
    feedback: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    reasoning: Literal["on", "off"]


async def chat_models(wanted: list[str]) -> list[dict]:
    """The catalog entries for the requested ids. 422 if one is not a chat model on the endpoint."""
    try:
        catalog = {m["id"]: m for m in await akamai.list_models() if m["kind"] == "chat"}
    except akamai.EndpointError as exc:
        raise HTTPException(exc.status, exc.message)
    missing = [m for m in wanted if m not in catalog]
    if missing:
        raise HTTPException(422, f"Not a chat model on this endpoint: {', '.join(missing)}")
    return [catalog[m] for m in dict.fromkeys(wanted)]


def create_app(transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        config.DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
        if config.DATA == config.ROOT / "data" and not config.DATA.is_symlink():
            # Also protect older saves in this app's default, dedicated directory.
            config.DATA.chmod(0o700)
        akamai.client = httpx.AsyncClient(
            transport=transport,
            trust_env=not config.BASE_URL.startswith("http:"),
            timeout=httpx.Timeout(connect=10, read=300, write=30, pool=120),
            limits=httpx.Limits(max_connections=64),
        )
        try:
            yield
        finally:
            pending = list(evals._jobs.values())
            pending.extend(job for group in sites._jobs.values() for job in group)
            for run_id in list(evals._jobs):
                evals.stop_run(run_id)
            for build_id in list(sites._jobs):
                sites.stop_build(build_id)
            await asyncio.gather(*pending, return_exceptions=True)
            await akamai.client.aclose()

    app = FastAPI(title="Akamai Inference model eval", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(Guard)

    # ------------------------------------------------------------ endpoint

    @app.get("/api/config")
    async def get_config():
        return {"base_url": config.BASE_URL, "key_set": bool(config.API_KEY)}

    @app.get("/api/models")
    async def get_models(refresh: bool = False):
        try:
            return {"base_url": config.BASE_URL, "models": await akamai.list_models(refresh)}
        except akamai.EndpointError as exc:
            raise HTTPException(exc.status, exc.message)

    # ------------------------------------------------------------ playground

    @app.post("/api/chat")
    async def chat(body: ChatRequest):
        """Stream one reply as server-sent events. See akamai.stream_chat for the event shapes."""
        for message in body.messages:
            if isinstance(message, UserMessage):
                validate_images(message)
        await chat_models([body.model])
        messages = [m.model_dump() for m in body.messages]
        if body.system.strip():
            messages.insert(0, {"role": "system", "content": body.system})
        upstream = akamai.request_body(
            body.model, messages, max_tokens=body.max_tokens,
            temperature=body.temperature, top_p=body.top_p, reasoning=body.reasoning,
        )

        async def events():
            async for event in akamai.stream_chat(upstream):
                yield f"data: {json.dumps(event)}\n\n"

        return StreamingResponse(
            events(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ------------------------------------------------------------ evals

    @app.get("/api/evals/tasks")
    async def get_tasks():
        return {"tasks": evals.all_tasks(), "graders": evals.GRADERS}

    @app.post("/api/evals/tasks")
    async def create_task(body: dict):
        try:
            return evals.save_custom_task(body)
        except ValueError as exc:
            raise HTTPException(422, str(exc))

    @app.delete("/api/evals/tasks/{task_id}")
    async def delete_task(task_id: str):
        if not evals.delete_custom_task(task_id):
            raise HTTPException(404, "No such custom task")
        return {"ok": True}

    @app.get("/api/evals/runs")
    async def get_runs():
        return {"runs": evals.list_runs()}

    @app.post("/api/evals/runs")
    async def create_run(body: RunRequest):
        models = [m["id"] for m in await chat_models(body.models)]
        try:
            run = evals.start_run(models, body.tasks, body.reasoning, body.limit)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        return evals.summarize(run)

    @app.get("/api/evals/runs/{run_id}")
    async def get_run(run_id: str):
        run = evals.get_run(run_id)
        if not run:
            raise HTTPException(404, "No such run")
        return evals.summarize(run)

    @app.get("/api/evals/runs/{run_id}/results")
    async def get_results(run_id: str, model: str, task: str):
        run = evals.get_run(run_id)
        if not run:
            raise HTTPException(404, "No such run")
        return {"results": evals.cell_results(run, model, task)}

    @app.get("/api/evals/runs/{run_id}/compare/{baseline_id}")
    async def compare_eval_runs(run_id: str, baseline_id: str):
        selected, baseline = evals.get_run(run_id), evals.get_run(baseline_id)
        if selected is None or baseline is None:
            raise HTTPException(404, "No such eval run")
        if run_id == baseline_id:
            raise HTTPException(422, "Choose two different runs")
        return evals.compare_runs(baseline, selected)

    @app.get("/api/evals/runs/{run_id}/export")
    async def export_run(run_id: str):
        run = evals.get_run(run_id)
        if not run:
            raise HTTPException(404, "No such run")
        export = run | {"results": [evals.explain_result(r) for r in run["results"]]}
        return JSONResponse(export, headers={"Content-Disposition": f'attachment; filename="eval-{run_id}.json"'})

    @app.post("/api/evals/runs/{run_id}/stop")
    async def stop_run(run_id: str):
        return {"stopped": evals.stop_run(run_id)}

    @app.delete("/api/evals/runs/{run_id}")
    async def delete_run(run_id: str):
        if not evals.delete_run(run_id):
            raise HTTPException(409, "Run not found, or still running")
        return {"ok": True}

    # ------------------------------------------------------------ websites

    @app.get("/api/sites/challenges")
    async def get_challenges():
        return {"challenges": sites.challenges(), "max_models": sites.MAX_MODELS}

    @app.get("/api/sites/builds")
    async def get_builds():
        return {"builds": sites.list_builds()}

    @app.post("/api/sites/builds")
    async def create_build(body: BuildRequest):
        models = await chat_models(body.models)
        try:
            return sites.start_build(models, body.prompt, body.challenge, body.reasoning)
        except ValueError as exc:
            raise HTTPException(422, str(exc))

    @app.get("/api/sites/builds/{build_id}")
    async def get_build(build_id: str):
        build = sites.get_build(build_id)
        if not build:
            raise HTTPException(404, "No such build")
        return build | {"running": build_id in sites._jobs}

    @app.post("/api/sites/builds/{build_id}/stop")
    async def stop_build(build_id: str):
        return {"stopped": sites.stop_build(build_id)}

    @app.post("/api/sites/builds/{build_id}/{site_id}/repair")
    async def repair_site(build_id: str, site_id: str, body: RepairRequest):
        build = sites.get_build(build_id)
        site = next((s for s in build["sites"] if s["id"] == site_id), None) if build else None
        if site is None:
            raise HTTPException(404, "No such page")
        model, = await chat_models([site["model"]])
        try:
            return sites.start_repair(build_id, site_id, model, body.feedback, body.reasoning)
        except KeyError as exc:
            raise HTTPException(404, exc.args[0])
        except ValueError as exc:
            raise HTTPException(422, str(exc))

    @app.delete("/api/sites/builds/{build_id}")
    async def delete_build(build_id: str):
        if not sites.delete_build(build_id):
            raise HTTPException(409, "Build not found, or still running")
        return {"ok": True}

    @app.get("/api/sites/builds/{build_id}/{site_id}/html")
    async def site_html(build_id: str, site_id: str, download: bool = False):
        """The generated page. The CSP keeps it sandboxed even if this URL is opened directly."""
        try:
            path = sites.html_path(build_id, site_id)
        except KeyError:
            raise HTTPException(404, "No such page")
        if not path.exists():
            raise HTTPException(404, "No page was saved for this model")
        headers = {
            "Content-Security-Policy": sites.PREVIEW_CSP,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
        }
        if download:
            build = sites.get_build(build_id) or {"sites": []}
            model = next((s["model"] for s in build["sites"] if s["id"] == site_id), site_id)
            filename = re.sub(r"[^A-Za-z0-9._-]", "_", model)
            headers["Content-Disposition"] = f'attachment; filename="{filename}.html"'
        return HTMLResponse(path.read_text(), headers=headers)

    @app.put("/api/sites/builds/{build_id}/{site_id}/review")
    async def put_review(build_id: str, site_id: str, body: ReviewRequest):
        site = sites.review(build_id, site_id, body.stars, body.checks, body.notes)
        if not site:
            raise HTTPException(404, "No such page")
        return site

    # ------------------------------------------------------------ frontend

    @app.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "No such API route")
        dist = config.WEB_DIST.resolve()
        if not (dist / "index.html").exists():
            return PlainTextResponse("The frontend is not built yet. Run: make build", 503)
        file = (dist / path).resolve()
        if path and file != dist / "index.html" and file.is_file() and file.is_relative_to(dist):
            return FileResponse(file)
        return FileResponse(dist / "index.html", headers=APP_HEADERS)

    return app


app = create_app()
