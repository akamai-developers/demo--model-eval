import assert from "node:assert/strict";
import test from "node:test";
import { changeModel, DEFAULTS, newSession, restoreSession } from "../src/lib/playgroundSessions.ts";

test("switching models restores each model's transcript and last-request settings", () => {
  const file = { kind: "text", id: "notes", name: "notes.md", size: 3, text: "May" };
  const first = { key: 1, model: "alpha", turns: [
    { role: "user", content: "", attachments: [file] },
    { role: "assistant", model: "alpha", content: "May" },
  ], lastRequest: { model: "alpha", turnCount: 1, reasoning: "off" } };
  const next = changeModel(first, "beta");
  assert.deepEqual(next.turns, []);
  assert.equal(next.lastRequest, undefined);
  next.turns.push({ role: "assistant", model: "beta", content: "June" });
  const back = changeModel(next, "alpha");
  assert.deepEqual(back.turns, first.turns);
  assert.deepEqual(back.lastRequest, first.lastRequest);
  assert.deepEqual(changeModel(back, "beta").turns, next.turns);
});

test("reopening an interrupted session retains its partial answer and draft attachments", () => {
  const session = newSession({ ...DEFAULTS, reasoning: "on" }, ["alpha", "beta"]);
  const image = { kind: "image", name: "test.png", id: "file", size: 12, dataUrl: "data:image/png;base64,YQ==" };
  session.draft = "next question";
  session.attachments = [image];
  session.lanes[0].turns = [{ role: "assistant", status: "streaming", content: "Partway" }];
  const restored = restoreSession(session);
  assert.deepEqual(restored.lanes[0].turns, [{ role: "assistant", status: "stopped", content: "Partway" }]);
  assert.equal(restored.settings.reasoning, "on");
  assert.deepEqual(restored.attachments, [image]);
  assert.equal(restored.draft, "next question");
  assert.equal(session.lanes[0].turns[0].status, "streaming");
  assert.notEqual(newSession(DEFAULTS).id, session.id);
});
