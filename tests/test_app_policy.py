import stat

import pytest

from server import akamai, app, config
from server.storage import atomic_text
from tests.conftest import calls


def test_app_routes_and_direct_index_use_the_same_browser_policy(client, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "WEB_DIST", tmp_path)
    (tmp_path / "index.html").write_text("<title>Model Eval</title>")
    for route in ("/", "/index.html", "/playground", "/evals", "/websites"):
        response = client.get(route)
        assert response.status_code == 200
        policy = response.headers["content-security-policy"]
        assert "frame-ancestors 'none'" in policy and "frame-src 'self'" in policy
        assert "script-src 'self';" in policy and response.headers["x-frame-options"] == "DENY"


@pytest.mark.parametrize("with_length", [True, False])
def test_chat_rejects_oversize_bodies_before_inference(client, monkeypatch, with_length):
    monkeypatch.setattr(app, "CHAT_BODY_LIMIT", 64)
    chunks = [b" " * 40, b" " * 40]
    response = client.post("/api/chat", content=b"".join(chunks) if with_length else iter(chunks),
                           headers={"content-type": "application/json"})
    assert response.status_code == 413
    assert "new session" in response.json()["detail"]
    assert not calls


def test_generated_files_are_private_and_never_publish_partial_writes(tmp_path):
    path = tmp_path / "build" / "page.html"
    with atomic_text(path) as output:
        output.write("café")
        assert output.tell() == len("café".encode())
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    with pytest.raises(ValueError):
        with atomic_text(path) as output:
            output.write("incomplete")
            raise ValueError("interrupted")
    assert path.read_text() == "café"


def test_upstream_error_removes_the_configured_key(monkeypatch):
    monkeypatch.setattr(config, "API_KEY", "unit-test-secret")
    assert akamai._error_message(400, '{"error":{"message":"Invalid value unit-test-secret"}}') == "Invalid value [redacted]"
