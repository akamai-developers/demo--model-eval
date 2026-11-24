import base64

import pytest

from server import akamai, app


PNG = b"\x89PNG\r\n\x1a\n"


def image(data=PNG, mime="image/png"):
    url = f"data:{mime};base64," + base64.b64encode(data).decode("ascii")
    return {"type": "image_url", "image_url": {"url": url}}


def test_mixed_content_survives_follow_up(client, monkeypatch):
    messages = [
        {"role": "user", "content": [
            {"type": "text", "text": "File: notes.txt\nReview the caption."},
            image(), {"type": "text", "text": "Compare with this image."},
            image(b"RIFF1234WEBP", "image/webp"),
        ]},
        {"role": "assistant", "content": "The captions match."},
        {"role": "user", "content": "File: corrections.txt\nChange the date."},
    ]
    sent = []

    async def stream(body):
        sent.append(body)
        yield {"type": "done"}

    monkeypatch.setattr(akamai, "stream_chat", stream)
    response = client.post("/api/chat", json={"model": "alpha", "messages": messages, "system": "Be concise."})
    assert response.status_code == 200
    assert sent[0]["messages"] == [{"role": "system", "content": "Be concise."}, *messages]


@pytest.mark.parametrize(("content", "detail"), [
    ([{"type": "image_url", "image_url": {"url": "https://example.test/photo.png"}}], "local"),
    ([{"type": "image_url", "image_url": {"url": "data:image/png;base64,@@"}}], "base64"),
    ([image(b"plain text")], "file type"),
    ([image(mime="image/svg+xml")], "local"),
    ([image()] * 5, "four images"),
])
def test_invalid_images_get_actionable_errors(client, content, detail):
    response = client.post("/api/chat", json={"model": "alpha", "messages": [{"role": "user", "content": content}]})
    assert response.status_code == 422
    assert detail in response.json()["detail"]


def test_assistant_content_stays_text_only(client):
    response = client.post("/api/chat", json={"model": "alpha", "messages": [{"role": "assistant", "content": [image()]}]})
    assert response.status_code == 422


def test_image_limits_apply_to_decoded_bytes_per_turn(client, monkeypatch):
    monkeypatch.setattr(app, "IMAGE_LIMIT", 10)
    monkeypatch.setattr(app, "TURN_IMAGE_LIMIT", 20)

    async def stream(body):
        yield {"type": "done"}

    monkeypatch.setattr(akamai, "stream_chat", stream)

    def send(*parts):
        messages = [{"role": "user", "content": content} for content in parts]
        return client.post("/api/chat", json={"model": "alpha", "messages": messages})

    jpeg = image(b"\xff\xd8\xff" + bytes(7), "image/jpeg")
    assert send([jpeg, jpeg], [jpeg]).status_code == 200
    assert "4 MiB" in send([image(PNG + bytes(3))]).json()["detail"]
    assert "8 MiB" in send([image(), image(), image()]).json()["detail"]
