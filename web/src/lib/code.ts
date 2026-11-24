import type { ChatBody } from "./api";

// The same request the playground just sent, as code you can paste. The key is
// read from the environment and never appears in the snippet.

function payload(body: ChatBody) {
  const messages = [
    ...(body.system.trim() ? [{ role: "system", content: body.system }] : []),
    ...body.messages,
  ];
  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(body.temperature != null && { temperature: body.temperature }),
    ...(body.top_p != null && { top_p: body.top_p }),
    ...(body.reasoning !== "default" && { chat_template_kwargs: { enable_thinking: body.reasoning === "on" } }),
  };
}

function shellString(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function curlSnippet(baseUrl: string, body: ChatBody): string {
  const json = JSON.stringify(payload(body), null, 2);
  return `curl -N ${shellString(baseUrl + "/chat/completions")} \\
  -H "Authorization: Bearer \${AKAMAI_API_KEY:-$AKAMAI_INFERENCE_API_KEY}" \\
  -H "Content-Type: application/json" \\
  --data-binary @- <<'MODEL_EVAL_JSON'
${json}
MODEL_EVAL_JSON`;
}

export function pythonSnippet(baseUrl: string, body: ChatBody): string {
  const p = payload(body);
  const lines = [
    `    model=${JSON.stringify(p.model)},`,
    `    messages=${JSON.stringify(p.messages, null, 4).replaceAll("\n", "\n    ")},`,
    `    max_tokens=${p.max_tokens},`,
    ...(p.temperature != null ? [`    temperature=${p.temperature},`] : []),
    ...(p.top_p != null ? [`    top_p=${p.top_p},`] : []),
    "    stream=True,",
    '    stream_options={"include_usage": True},',
    ...(p.chat_template_kwargs ? [`    extra_body={"chat_template_kwargs": {"enable_thinking": ${p.chat_template_kwargs.enable_thinking ? "True" : "False"}}},`] : []),
  ];
  return `import os
from openai import OpenAI

client = OpenAI(
    base_url=${JSON.stringify(baseUrl)},
    api_key=os.getenv("AKAMAI_API_KEY") or os.environ["AKAMAI_INFERENCE_API_KEY"],
)

response = client.chat.completions.create(
${lines.join("\n")}
)
for chunk in response:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
print()`;
}

export function nodeSnippet(baseUrl: string, body: ChatBody): string {
  const request = JSON.stringify(payload(body), null, 2);
  return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: ${JSON.stringify(baseUrl)},
  apiKey: process.env.AKAMAI_API_KEY || process.env.AKAMAI_INFERENCE_API_KEY,
});

const response = await client.chat.completions.create(${request});
for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
console.log();`;
}
