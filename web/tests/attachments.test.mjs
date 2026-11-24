import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { addAttachments, userContent } from "../src/lib/attachments.ts";
import { curlSnippet } from "../src/lib/code.ts";

const pngHeader = [137, 80, 78, 71, 13, 10, 26, 10];

test("text and code files retain their name, contents and newlines in a plain chat message", async () => {
  const source = "region,sales\nNorth,23\n";
  const attachments = await addAttachments([], [new File([source], "report.csv")]);
  assert.equal(userContent("Find the total.", attachments), "Find the total.\n\nFile: report.csv\n" + source);
  assert.equal(userContent("Next question"), "Next question");
});

test("mixed attachments send their actual bytes and the shell snippet streams a large image on stdin", async () => {
  const image = new Uint8Array(170000).map((_, i) => i % 251);
  image.set(pngHeader);
  const files = await addAttachments([], [
    new File(["Labels: 'red' and blue\nMODEL_EVAL_JSON\n"], "notes.txt"),
    new File([image], "sample.png"),
  ]);
  const content = userContent("", files);
  assert.equal(content[0].type, "text");
  assert.match(content[0].text, /Labels: 'red' and blue/);
  assert.match(content[0].text, /sample\.png/);
  assert.equal(content[1].image_url.url, "data:image/png;base64," + Buffer.from(image).toString("base64"));
  const snippet = curlSnippet("https://example.test/v1", {
    model: "vision", messages: [{ role: "user", content }], system: "", max_tokens: 32, temperature: null, top_p: null, reasoning: "default",
  });
  const shell = spawnSync("sh", { input: "curl() { cat; }\n" + snippet, encoding: "utf8" });
  assert.equal(shell.status, 0, shell.stderr);
  assert.deepEqual(JSON.parse(shell.stdout).messages[0].content, content);
});

test("invalid formats and file limits return an actionable error", async () => {
  const read = (file) => addAttachments([], [file]);
  await assert.rejects(read(new File(["hello"], "essay.docx")), /unsupported/);
  await assert.rejects(read(new File(["bad"], "picture.jpg")), /does not contain/);
  await assert.rejects(read(new File([new Uint8Array([255, 255])], "invalid.log")), /UTF-8/);
  await assert.rejects(read(new File(["ab\u0000cd"], "binary.txt")), /binary/);
  await assert.rejects(read(new File([new Uint8Array(128 * 1024 + 1)], "large.txt")), /128 KiB/);
  await assert.rejects(read(new File([], "empty.md")), /empty/);
  await assert.rejects(addAttachments([], Array(5).fill(new File(["x"], "note.txt"))), /up to four/);
  await assert.rejects(addAttachments([], Array(3).fill(new File([new Uint8Array(3 * 1024 * 1024)], "a.png"))), /8 MiB/);
});
