import assert from "node:assert/strict";
import test from "node:test";
import { streamChat } from "../src/lib/api.ts";
import { curlSnippet, nodeSnippet, pythonSnippet } from "../src/lib/code.ts";

const request = {
  model: "alpha",
  system: "Preserve case.",
  messages: [{ role: "user", content: "Return true, false and null." }],
  reasoning: "off",
  temperature: 0,
  top_p: null,
  max_tokens: 200,
};

test("code examples preserve the prompt and streaming options", () => {
  for (const snippet of [pythonSnippet, curlSnippet, nodeSnippet]) {
    const code = snippet("https://example.test/v1", request);
    assert.ok(code.includes(request.messages[0].content));
    assert.ok(code.includes(request.system));
    assert.match(code, /include_usage/);
    assert.match(code, /AKAMAI_API_KEY[^\n]*AKAMAI_INFERENCE_API_KEY/);
    assert.match(code, /"enable_thinking": (False|false)/);
    assert.ok(!code.includes("top_p"));
  }
});

test("partial text stays visible and a truncated stream reports a failure", async (t) => {
  const delta = { type: "delta", content: "part", reasoning: "" };
  t.mock.method(globalThis, "fetch", async () => new Response(`data: ${JSON.stringify(delta)}\n\n`));
  const events = [];
  await assert.rejects(streamChat(request, (event) => events.push(event), new AbortController().signal), /closed/);
  assert.deepEqual(events, [delta]);
});
