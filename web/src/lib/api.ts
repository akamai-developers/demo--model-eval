// Every call the browser makes goes to this app's own /api. The Akamai key
// lives on the server.

export type Reasoning = "default" | "on" | "off";

export interface Model {
  id: string;
  kind: "chat" | "embedding";
  max_output_tokens: number | null;
}

export interface Metrics {
  finish_reason: string | null;
  ttft_ms: number | null;
  total_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  tokens_per_second: number | null;
}

export type ChatEvent =
  | { type: "delta"; content: string; reasoning: string }
  | ({ type: "done" } & Metrics)
  | { type: "error"; status: number; message: string };

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatContent = string | ChatContentPart[];

export interface ChatBody {
  model: string;
  messages: { role: "user" | "assistant"; content: ChatContent }[];
  system: string;
  max_tokens: number;
  temperature: number | null;
  top_p: number | null;
  reasoning: Reasoning;
}

async function fail(response: Response): Promise<never> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail)) message = body.detail.map((d: { msg: string }) => d.msg).join(". ");
  } catch {
    /* not JSON */
  }
  throw new Error(message);
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) await fail(response);
  return response.json();
}

/** Stream one reply. Calls onEvent for each server-sent event until the stream ends or is aborted. */
export async function streamChat(body: ChatBody, onEvent: (event: ChatEvent) => void, signal: AbortSignal) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) await fail(response);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      if (line.startsWith("data: ")) {
        const event: ChatEvent = JSON.parse(line.slice(6));
        onEvent(event);
        if (event.type === "done" || event.type === "error") finished = true;
      }
    }
  }
  if (!finished) throw new Error("The connection closed before the reply finished.");
}

// ---- evals

export interface EvalExample {
  id: string;
  input: string;
  expected: unknown;
}

export interface EvalTask {
  id: string;
  name: string;
  group: string;
  goal: string;
  grader: string;
  system: string;
  notes: string;
  examples: EvalExample[];
  custom: boolean;
}

export interface EvalCell {
  right_tool?: number;
  done: number;
  total: number;
  passed: number;
  errors: number;
}

export interface EvalRow {
  model: string;
  cells: Record<string, EvalCell>;
  score: number | null;
  passed: number;
  done: number;
  errors: number;
  median_ms: number | null;
  median_ttft_ms: number | null;
  tokens_per_second: number | null;
  completion_tokens: number;
}

export interface EvalRun {
  id: string;
  started: number;
  status: "running" | "done" | "stopped";
  models: string[];
  reasoning: Reasoning;
  tasks: { id: string; name: string; grader: string; examples: number; grader_version?: string }[];
  total: number;
  done: number;
  elapsed_ms: number;
  rate_limit_wait_ms: number;
  rows: EvalRow[];
}

export interface EvalRunSummary {
  id: string;
  reasoning?: Reasoning | null;
  started: number;
  status: string;
  models: string[];
  tasks: string[];
  total: number;
  done: number;
}

export interface EvalResult {
  tool_checks?: ToolChecks;
  tool_trace?: ToolStage[];
  model: string;
  task: string;
  example: string;
  input: string;
  expected: unknown;
  output: string;
  reasoning: string;
  passed: boolean;
  notes: string[];
  error?: string;
  ttft_ms: number | null;
  total_ms: number | null;
  completion_tokens: number | null;
  reasoning_tokens?: number | null;
  tokens_per_second: number | null;
  finish_reason: string | null;
}

export interface ToolChecks {
  selection: boolean | null;
  arguments: boolean | null;
  format: boolean | null;
  detail?: string;
}

export interface ToolStage {
  calls: { id?: string | null; type?: string; name?: string | null; arguments?: string | null }[];
  expected?: unknown;
  observation?: unknown;
  output?: string;
  error?: string;
  format?: boolean | null;
  selection?: boolean | null;
  arguments?: boolean | null;
}

// ---- websites

export interface Challenge {
  id: string;
  name: string;
  difficulty: string;
  prompt: string;
  checks: string[];
}

export interface Site {
  id: string;
  model: string;
  status: "queued" | "writing" | "done" | "error" | "stopped";
  started: number | null;
  chars: number;
  thinking_chars: number;
  tail: string;
  parts: number;
  bytes: number;
  complete: boolean;
  ttft_ms: number | null;
  total_ms: number | null;
  completion_tokens: number;
  reasoning_tokens?: number | null;
  reasoning_tokens_complete?: boolean;
  tokens_per_second: number | null;
  finish_reason: string | null;
  error: string | null;
  stars: number;
  checks: Record<string, boolean>;
  notes: string;
}

export interface SiteRepair {
  build_id: string;
  site_id: string;
  feedback: string;
}

export interface Build {
  id: string;
  started: number;
  challenge: { id: string; name: string; difficulty: string | null; checks: string[] };
  prompt: string;
  reasoning: Reasoning;
  repair?: SiteRepair | null;
  sites: Site[];
  running: boolean;
}

export interface BuildSummary {
  id: string;
  started: number;
  name: string;
  difficulty: string | null;
  reasoning?: Reasoning;
  repair?: SiteRepair | null;
  sites: { model: string; status: string; stars: number }[];
}
