import { ArrowDown, ArrowUp, Check, ChevronDown, CircleAlert, Columns2, Download, Play, Plus, SlidersHorizontal, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DocLink } from "../components/DocLink";
import { ModelChips } from "../components/ModelPicker";
import { reasoningLabel, runLabel, RunComparison } from "../components/RunComparison";
import { Badge, Button, Callout, Card, Drawer, Field, Meter, Modal, Segmented, Spinner, StatTile } from "../components/ui";
import { api, type EvalResult, type EvalRow, type EvalRun, type EvalRunSummary, type EvalTask, type Reasoning } from "../lib/api";
import { docs } from "../lib/docs";
import { cx, duration, load, num, percent, save } from "../lib/format";
import { navigate } from "../lib/router";
import { useModels } from "../lib/models";
import "../styles/evals.css";

const GRADER_LABEL: Record<string, string> = { match: "Match", exact: "Exact", json: "JSON", checks: "Checks", tool_calls: "Native tools" };
// Two tasks, five examples each: a first run small enough to finish without hitting the rate limit.
const DEFAULT_TASKS = ["logic_puzzles", "tool_selection"];
const TOOL_REFERENCES: Record<string, { href: string; label: string }> = {
  coding_agent_tools: { href: docs.claudeTools, label: "Claude Code tool reference" },
  pi_coding_tools: { href: docs.piTools, label: "Pi tool definitions" },
  akamai_cloud_tools: { href: docs.cloudApi, label: "Akamai Cloud API reference" },
};

type SortKey = "score" | "median_ms" | "tokens_per_second" | "model" | `task:${string}`;

function expectedText(grader: string, expected: unknown): string {
  if (grader === "tool_calls" && expected && typeof expected === "object" && "steps" in expected && Array.isArray(expected.steps)) {
    const lines = expected.steps.map(step => JSON.stringify({ name: step.name, arguments: step.arguments }));
    if ("clarifies" in expected && Array.isArray(expected.clarifies)) lines.push(`Ask for clarification about ${expected.clarifies[0]} without calling a tool.`);
    if ("answer" in expected && Array.isArray(expected.answer)) lines.push(`Reply with ${expected.answer.join(" or ")}.`);
    return lines.join("\n") || "Respond without calling a tool.";
  }
  if (grader === "match") return (Array.isArray(expected) ? expected : [expected]).join("  or  ");
  if (grader === "checks" && expected && typeof expected === "object") {
    return Object.entries(expected as Record<string, unknown>)
      .map(([key, value]) => `${key.replace(/_/g, " ")}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("\n");
  }
  return typeof expected === "string" ? expected : JSON.stringify(expected);
}

function rate(cell: { passed: number; done: number } | undefined) {
  return cell && cell.done ? cell.passed / cell.done : null;
}

function sortValue(row: EvalRow, key: SortKey): number | string | null {
  if (key === "model") return row.model;
  if (key === "score" || key === "median_ms" || key === "tokens_per_second") return row[key];
  return rate(row.cells[key.slice(5)]);
}

// ------------------------------------------------------------ new task

interface DraftExample {
  input: string;
  expected: string;
}

const EXPECTED_HINT: Record<string, string> = {
  match: "Accepted answers, separated by |",
  exact: "The exact text",
  json: 'A JSON value, such as {"label": "spam"}',
  checks: 'Limits as JSON, such as {"max_words": 30, "includes": ["refund"]}',
};

function NewTask({ open, onClose, graders, onSaved }: { open: boolean; onClose: () => void; graders: Record<string, string>; onSaved: (task: EvalTask) => void }) {
  const [name, setName] = useState("");
  const [system, setSystem] = useState("");
  const [grader, setGrader] = useState("match");
  const [examples, setExamples] = useState<DraftExample[]>([{ input: "", expected: "" }, { input: "", expected: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError(null);
    const rows = examples.filter((e) => e.input.trim() || e.expected.trim());
    try {
      const body = {
        name,
        system,
        grader,
        examples: rows.map((row, i) => {
          if (grader === "match") return { input: row.input, expected: row.expected.split("|").map((s) => s.trim()).filter(Boolean) };
          if (grader === "exact") return { input: row.input, expected: row.expected };
          try {
            return { input: row.input, expected: JSON.parse(row.expected) };
          } catch {
            throw new Error(`Example ${i + 1}: the expected value is not valid JSON.`);
          }
        }),
      };
      setSaving(true);
      const task = await api<EvalTask>("/evals/tasks", { body });
      onSaved(task);
      setName("");
      setSystem("");
      setExamples([{ input: "", expected: "" }, { input: "", expected: "" }]);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="New task"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            Save task
          </Button>
        </>
      }
    >
      <div className="form">
        {error && <Callout tone="red">{error}</Callout>}
        <Field label="Name">
          <input value={name} maxLength={80} placeholder="Support ticket routing" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="System prompt" hint="Tell the model the task and the exact shape of the answer.">
          <textarea rows={3} value={system} placeholder="Label the ticket as billing, bug or account. Return one word." onChange={(e) => setSystem(e.target.value)} />
        </Field>
        <div className="field">
          <span className="field-label">Grader</span>
          <Segmented
            label="Grader"
            value={grader}
            onChange={setGrader}
            options={Object.keys(graders).map((value) => ({ value, label: GRADER_LABEL[value] ?? value }))}
          />
          <span className="field-hint">{graders[grader]}</span>
        </div>
        <div className="field">
          <span className="field-label">Examples</span>
          <div className="example-rows">
            {examples.map((example, i) => (
              <div className="example-row" key={i}>
                <textarea
                  rows={2}
                  aria-label={`Example ${i + 1} input`}
                  placeholder="Input sent to the model"
                  value={example.input}
                  onChange={(e) => setExamples(examples.map((x, j) => (j === i ? { ...x, input: e.target.value } : x)))}
                />
                <textarea
                  rows={2}
                  aria-label={`Example ${i + 1} expected`}
                  placeholder={EXPECTED_HINT[grader]}
                  value={example.expected}
                  onChange={(e) => setExamples(examples.map((x, j) => (j === i ? { ...x, expected: e.target.value } : x)))}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove example ${i + 1}`}
                  icon={<X size={16} />}
                  disabled={examples.length === 1}
                  onClick={() => setExamples(examples.filter((_, j) => j !== i))}
                />
              </div>
            ))}
          </div>
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setExamples([...examples, { input: "", expected: "" }])}>
            Add example
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ answers drawer

function Answers({ run, cell, onClose }: { run: EvalRun; cell: { model: string; task: string; example?: string }; onClose: () => void }) {
  const [results, setResults] = useState<EvalResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "failed">("all");
  const task = run.tasks.find((t) => t.id === cell.task);
  const reference = TOOL_REFERENCES[cell.task];
  const done = run.rows.find((row) => row.model === cell.model)?.cells[cell.task]?.done;

  useEffect(() => {
    let active = true;
    const query = `model=${encodeURIComponent(cell.model)}&task=${encodeURIComponent(cell.task)}`;
    api<{ results: EvalResult[] }>(`/evals/runs/${run.id}/results?${query}`)
      .then((data) => {
        if (active) {
          setResults([...data.results].sort((a, b) => a.example.localeCompare(b.example)));
          setError(null);
        }
      })
      .catch((e: Error) => { if (active) setError(`Could not load the answers. ${e.message}`); });
    return () => { active = false; };
  }, [cell, run.id, done]);

  useEffect(() => {
    if (results && cell.example) document.getElementById(`eval-answer-${cell.example}`)?.scrollIntoView({ block: "center" });
  }, [results, cell.example]);

  const passed = results?.filter((r) => r.passed).length ?? 0;
  const shown = results?.filter((r) => filter === "all" || !r.passed) ?? [];

  return (
    <Drawer
      open
      onClose={onClose}
      title={task?.name ?? ""}
      subtitle={
        <>
          <span className="mono">{cell?.model}</span>
          {results && ` · ${passed} of ${results.length} passed`}
          {` · Reasoning ${reasoningLabel(run.reasoning)}`}
          {reference && <div><DocLink href={reference.href}>{reference.label}</DocLink></div>}
        </>
      }
    >
      {error && <Callout tone="red">{error}</Callout>}
      {!results && !error && <Spinner />}
      {results && (
        <>
          <div className="answers-bar">
            <Segmented
              size="sm"
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `All ${results.length}` },
                { value: "failed", label: `Failed ${results.length - passed}` },
              ]}
            />
            <span className="muted small">Grader: {GRADER_LABEL[task?.grader ?? ""]}{task?.grader === "tool_calls" &&
              (task.grader_version === "schema-defaults-v2" ? " · schema defaults" : " · exact arguments")}</span>
          </div>
          <ol className="answers">
            {shown.map((result) => (
              <li key={result.example} id={`eval-answer-${result.example}`} className="answer">
                <div className="answer-head">
                  {result.passed ? (
                    <Badge tone="green">
                      <Check size={12} strokeWidth={3} /> Pass
                    </Badge>
                  ) : (
                    <Badge tone="red">
                      <X size={12} strokeWidth={3} /> {result.error ? "Error" : "Fail"}
                    </Badge>
                  )}
                  <span className="muted small mono">
                    {duration(result.total_ms)} · {result.completion_tokens ?? "–"} tokens
                    {result.reasoning_tokens != null && ` · ${num(result.reasoning_tokens)} reasoning`}
                  </span>
                </div>
                {result.tool_checks && <div className="tool-verdict">
                  {(["selection", "arguments", "format"] as const).map((key, i) => {
                    const value = result.tool_checks![key];
                    return <Badge key={key} tone={value == null ? "neutral" : value ? "green" : "orange"}>
                      {["Tool choice", "Argument values", "Call format"][i]} · {value == null ? "Unscored" : value ? "Pass" : "Fail"}
                    </Badge>;
                  })}
                  {result.tool_checks.detail && <p>{result.tool_checks.detail}</p>}
                </div>}
                <dl>
                  <dt>Input</dt>
                  <dd className="answer-input">{result.input}</dd>
                  <dt>Expected</dt>
                  <dd>{expectedText(task?.grader ?? "", result.expected)}</dd>
                  <dt>Answer</dt>
                  <dd className={cx("answer-output", !result.passed && "is-wrong")}>
                    {result.error ?? (result.output || <span className="muted">{result.tool_trace?.length ? "See recorded tool calls below" : "No text returned"}</span>)}
                  </dd>
                </dl>
                {!!result.tool_trace?.length && <details className="tool-trace">
                  <summary>Tool trace · {result.tool_trace.length} {result.tool_trace.length === 1 ? "step" : "steps"}</summary>
                  <ol>{result.tool_trace.map((stage, i) => <li key={i}>
                    <div className="tool-verdict">
                      {(["selection", "arguments", "format"] as const).map((key, j) => stage[key] == null ? null :
                        <Badge key={key} tone={stage[key] ? "green" : "orange"}>{["Choice", "Arguments", "Format"][j]} · {stage[key] ? "Pass" : "Fail"}</Badge>)}
                    </div>
                    {stage.calls.length ? stage.calls.map((call, j) => <pre key={j}>{call.name || "(missing tool name)"}{"\n"}{call.arguments}</pre>)
                      : <p>{stage.output || "No native tool call"}</p>}
                    {stage.observation != null && <><strong>Simulated tool result</strong><pre>{typeof stage.observation === "string" ? stage.observation : JSON.stringify(stage.observation, null, 2)}</pre></>}
                    {stage.error && <p>{stage.error}</p>}
                  </li>)}</ol>
                </details>}
                {result.notes.length > 0 && (
                  <ul className="answer-notes">
                    {result.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
            {!shown.length && <p className="muted">Nothing to show.</p>}
          </ol>
        </>
      )}
    </Drawer>
  );
}

// ------------------------------------------------------------ results

function Results({ run, onCell }: { run: EvalRun; onCell: (cell: { model: string; task: string }) => void }) {
  const [sort, setSort] = useState<SortKey>("score");
  const [ascending, setAscending] = useState(false);
  const SortArrow = ascending ? ArrowUp : ArrowDown;
  function sortBy(key: SortKey) {
    setAscending(key === sort ? !ascending : key === "model" || key === "median_ms");
    setSort(key);
  }
  const rows = useMemo(() => {
    return [...run.rows].sort((a, b) => {
      const x = sortValue(a, sort);
      const y = sortValue(b, sort);
      if (x === null && y !== null) return 1;
      if (y === null && x !== null) return -1;
      const order = x === null || y === null ? 0 : x < y ? -1 : x > y ? 1 : 0;
      return (ascending ? order : -order) || a.model.localeCompare(b.model);
    });
  }, [run.rows, sort, ascending]);

  const scores = run.rows.map((r) => r.score).filter((n): n is number => n !== null).sort((a, b) => b - a);
  const leaders = run.rows.filter((r) => r.score === scores[0]);
  const fastest = run.rows.filter((r) => r.tokens_per_second).sort((a, b) => b.tokens_per_second! - a.tokens_per_second!)[0];
  const errors = run.rows.reduce((sum, r) => sum + r.errors, 0);
  const direction = (key: SortKey) => sort === key ? (ascending ? "ascending" : "descending") : undefined;

  const header = (key: SortKey, label: string, align?: "num") => (
    <th className={cx(align === "num" && "num")} aria-sort={direction(key)}>
      <button type="button" className={cx("th-sort", sort === key && "is-on")} onClick={() => sortBy(key)} title={`Sort by ${label}`}>
        {label}
        {sort === key && <SortArrow size={12} aria-hidden="true" />}
      </button>
    </th>
  );

  return (
    <>
      <div className="stat-row">
        <StatTile
          accent
          label="Top score"
          value={percent(scores[0] ?? null)}
          detail={leaders.length > 1 ? `${leaders.length} models tied` : leaders[0]?.model ?? "Waiting for answers"}
        />
        <StatTile
          label="Fastest output"
          value={fastest ? `${Math.round(fastest.tokens_per_second!)} tok/s` : "–"}
          detail={fastest ? <span className="mono">{fastest.model}</span> : "Waiting for answers"}
        />
        <StatTile label={run.tasks.some(t => t.grader === "tool_calls") ? "Scored cases" : "Requests"} value={`${run.done} / ${run.total}`} detail={`${duration(run.elapsed_ms)} elapsed`} />
        <StatTile label="Request errors" value={errors} detail={errors ? "Counted as failed" : undefined} />
      </div>

      <Card className="table-card">
        <div className="table-scroll">
          <table className="matrix">
            <thead>
              <tr>
                <th className="num">#</th>
                {header("model", "Model")}
                {header("score", "Score")}
                {run.tasks.map((task) => (
                  <th key={task.id} className="task-col" aria-sort={direction(`task:${task.id}`)} title={`${task.name}: ${task.examples} examples, graded by ${task.grader}`}>
                    <button type="button" className={cx("th-sort", sort === `task:${task.id}` && "is-on")} onClick={() => sortBy(`task:${task.id}`)}>
                      {task.name}
                      {sort === `task:${task.id}` && <SortArrow size={12} aria-hidden="true" />}
                    </button>
                  </th>
                ))}
                {header("median_ms", "Median time", "num")}
                {header("tokens_per_second", "Tok/s", "num")}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.model} className={cx(row.score === scores[0] && run.status !== "running" && "is-best")}>
                  <td className="num muted">{row.score === null ? "–" : scores.indexOf(row.score) + 1}</td>
                  <th scope="row" className="mono model-cell">
                    {row.model}
                  </th>
                  <td className="score-cell">
                    <span className="score-number">{percent(row.score)}</span>
                    <Meter strong value={row.score} label={`${row.model} overall score ${percent(row.score)}`} />
                  </td>
                  {run.tasks.map((task) => {
                    const cell = row.cells[task.id];
                    const value = rate(cell);
                    return (
                      <td key={task.id} className="task-cell">
                        <button
                          type="button"
                          className="cell-button"
                          disabled={!cell?.done}
                          onClick={() => onCell({ model: row.model, task: task.id })}
                          aria-label={`Read ${row.model} answers for ${task.name}, ${cell?.passed ?? 0} of ${cell?.done ?? 0} passed`}
                          title={cell?.done ? `${cell.passed} of ${cell.done} passed. Click to read the answers.` : "No answers yet"}
                        >
                          <span className="cell-top">
                            <span className="cell-number">{value == null ? "–" : percent(value)}</span>
                            <span className="cell-count">
                              {cell?.done ? `${cell.passed}/${cell.done}` : ""}
                              {cell?.errors ? <CircleAlert size={12} className="cell-error" aria-label={`${cell.errors} request errors`} /> : null}
                            </span>
                          </span>
                          <Meter value={value} />
                          {cell?.right_tool != null && cell.done > 0 && <span className="cell-tool-choice">{cell.right_tool}/{cell.done} right tool</span>}
                        </button>
                      </td>
                    );
                  })}
                  <td className="num mono">{duration(row.median_ms)}</td>
                  <td className="num mono">{row.tokens_per_second ? Math.round(row.tokens_per_second) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="table-note">
          Score is the average of the task pass rates. Select a task score to inspect the answers. Timing is per request.
        </p>
      </Card>
    </>
  );
}

// ------------------------------------------------------------ page

export function Evals({ search }: { search: string }) {
  const query = new URLSearchParams(search);
  const requested = query.get("run");
  const baseline = query.get("compare");
  const linkedModel = query.get("model"), linkedTask = query.get("task"), linkedExample = query.get("example");
  const { chat } = useModels();
  const [tasks, setTasks] = useState<EvalTask[]>([]);
  const [graders, setGraders] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string[]>(() => load("evals.tasks", DEFAULT_TASKS));
  const [models, setModels] = useState<string[] | null>(() => load<string[] | null>("evals.models", null));
  const [reasoning, setReasoning] = useState<Reasoning>("off");
  const [limit, setLimit] = useState<"5" | "all">("5");
  const [run, setRun] = useState<EvalRun | null>(null);
  const [runs, setRuns] = useState<EvalRunSummary[]>([]);
  const [cell, setCell] = useState<{ model: string; task: string; example?: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [setupExpanded, setSetupExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const selection = useRef(0);
  const history = useRef(0);

  const loadRuns = useCallback(async () => {
    const request = ++history.current;
    try {
      const data = await api<{ runs: EvalRunSummary[] }>("/evals/runs");
      if (request === history.current) {
        setRuns(data.runs);
        return data.runs;
      }
    } catch (e) {
      if (request === history.current) setError(`Could not load run history. ${(e as Error).message}`);
    }
    return [];
  }, []);

  const selectRun = useCallback(async (id: string) => {
    const request = ++selection.current;
    setRunError(null);
    try {
      const next = await api<EvalRun>(`/evals/runs/${id}`);
      if (request === selection.current) {
        setCell(null);
        setPollError(null);
        setRun(next);
        if (location.pathname === "/evals" && !location.search) {
          window.history.replaceState(null, "", `/evals?run=${encodeURIComponent(next.id)}`);
        }
      }
    } catch (e) {
      if (request === selection.current) {
        setRun(null);
        setCell(null);
        setRunError(`Could not open this saved run. ${(e as Error).message}`);
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    const request = selection.current;
    api<{ tasks: EvalTask[]; graders: Record<string, string> }>("/evals/tasks").then((d) => {
      if (!active) return;
      setTasks(d.tasks);
      setGraders(d.graders);
    }).catch((e: Error) => { if (active) setError(`Could not load tasks. ${e.message}`); });
    loadRuns().then((list) => {
      if (active && request === selection.current && list[0] && !new URLSearchParams(location.search).get("run")) selectRun(list[0].id);
    });
    return () => {
      active = false;
      selection.current++;
      history.current++;
    };
  }, [loadRuns, selectRun]);

  useEffect(() => {
    if (requested) selectRun(encodeURIComponent(requested));
  }, [requested, selectRun]);

  useEffect(() => {
    if (run?.id === requested && linkedModel && linkedTask && run.models.includes(linkedModel) && run.tasks.some(t => t.id === linkedTask)) {
      setCell({ model: linkedModel, task: linkedTask, example: linkedExample ?? undefined });
    }
  }, [run?.id, requested, linkedModel, linkedTask, linkedExample]);

  function openAnswers(next: { model: string; task: string } | null) {
    setCell(next);
    if (location.pathname !== "/evals") return;
    const params = new URLSearchParams(location.search);
    if (run) params.set("run", run.id);
    for (const key of ["model", "task", "example"]) params.delete(key);
    if (next) { params.set("model", next.model); params.set("task", next.task); }
    window.history.replaceState(null, "", `/evals?${params}`);
  }

  function showRun(id: string, compare?: string | null) {
    const params = new URLSearchParams({ run: id });
    if (compare && compare !== id) params.set("compare", compare);
    navigate(`/evals?${params}`);
  }

  // Follow a run while it works.
  useEffect(() => {
    if (run?.status !== "running") return;
    let active = true;
    const runId = run.id;
    async function poll() {
      try {
        const next = await api<EvalRun>(`/evals/runs/${runId}`);
        if (!active) return;
        setPollError(null);
        setRun(next);
        if (next.status !== "running") loadRuns();
      } catch (e) {
        if (active) {
          setPollError(`Could not refresh the run. Retrying. ${(e as Error).message}`);
          timer = setTimeout(poll, 2000);
        }
      }
    }
    let timer = setTimeout(poll, 700);
    return () => { active = false; clearTimeout(timer); };
  }, [run, loadRuns]);

  const chosenModels = useMemo(() => {
    const ids = chat.map((m) => m.id);
    return models ? models.filter((id) => ids.includes(id)) : ids.slice(0, 1);
  }, [models, chat]);
  const chosenTasks = tasks.filter((t) => picked.includes(t.id));
  const caseUnits = chosenTasks.some(t => t.grader === "tool_calls") ? "cases" : "requests";
  const perTask = (task: EvalTask) => (limit === "5" ? Math.min(5, task.examples.length) : task.examples.length);
  const requests = chosenModels.length * chosenTasks.reduce((sum, t) => sum + perTask(t), 0);
  const running = run?.status === "running";

  useEffect(() => save("evals.tasks", picked), [picked]);
  useEffect(() => {
    if (models) save("evals.models", models);
  }, [models]);

  async function start() {
    if (starting || running || !requests) return;
    ++selection.current;
    setStarting(true);
    setError(null);
    setPollError(null);
    setCell(null);
    try {
      const body = { models: chosenModels, tasks: chosenTasks.map((t) => t.id), reasoning, limit: limit === "5" ? 5 : null };
      const next = await api<EvalRun>("/evals/runs", { body });
      setRun(next);
      showRun(next.id);
      setSetupExpanded(false);
      loadRuns();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const groups = [...new Set(tasks.map((t) => t.group))];

  return (
    <div className="eval-workspace">
      <header className="toolbar">
        <div>
          <h1>Evals</h1>
          <p className="muted">Choose tasks and models to start a run, or open a saved run to read its answers.</p>
        </div>
      </header>
      <div className="evals">
        <aside className="config" aria-label="Run setup">
          <header className="config-head">
            <h2 className="eval-setup-heading"><SlidersHorizontal size={16} /> Run setup</h2>
            <button type="button" className="eval-setup-toggle" aria-expanded={setupExpanded}
              aria-controls="eval-setup-fields" onClick={() => setSetupExpanded(!setupExpanded)}>
              <SlidersHorizontal size={16} />
              Run setup
              <ChevronDown size={16} />
            </button>
          </header>

          <div className={cx("eval-setup-fields", setupExpanded && "is-expanded")} id="eval-setup-fields">
            <section className="config-block">
              <div className="config-title">
                <h2>
                  Tasks <span className="count">{chosenTasks.length}</span>
                </h2>
                <span className="config-links">
                  <button type="button" onClick={() => setPicked(tasks.map((t) => t.id))}>
                    All
                  </button>
                  <button type="button" onClick={() => setPicked([])}>
                    None
                  </button>
                </span>
              </div>
              {groups.map((group) => {
                const groupTasks = tasks.filter((task) => task.group === group);
                const selected = groupTasks.filter((task) => picked.includes(task.id));
                return (
                  <details key={group} className="eval-task-group">
                    <summary>
                      <span>{group}</span>
                      <span className="eval-group-count">{selected.length} of {groupTasks.length}</span>
                      <ChevronDown size={14} />
                    </summary>
                    {groupTasks.map((task) => {
                      const on = picked.includes(task.id);
                      return (
                        <label key={task.id} className={cx("task", on && "is-on")} title={[task.goal, task.notes].filter(Boolean).join(". ")}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => setPicked(on ? picked.filter((id) => id !== task.id) : [...picked, task.id])}
                          />
                          <span className="task-text">
                            <span className="task-name">{task.name}</span>
                            {on && task.goal && <span className="task-goal">{task.goal}</span>}
                          </span>
                          <span className="task-meta">
                            <Badge title={graders[task.grader]}>{GRADER_LABEL[task.grader] ?? task.grader}</Badge>
                            <span className="muted small" title={`${task.examples.length} available examples`}>{task.examples.length}</span>
                          </span>
                          {task.custom && (
                            <button
                              type="button"
                              className="task-delete"
                              aria-label={`Delete ${task.name}`}
                              onClick={(e) => {
                                e.preventDefault();
                                if (!window.confirm(`Delete the custom task “${task.name}” and its examples? You can still read its saved runs.`)) return;
                                api(`/evals/tasks/${task.id}`, { method: "DELETE" }).then(() => {
                                  setTasks((items) => items.filter((t) => t.id !== task.id));
                                  setPicked((ids) => ids.filter((id) => id !== task.id));
                                }).catch((err: Error) => setError(`Could not delete the task. ${err.message}`));
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </label>
                      );
                    })}
                    {selected.map(({ id }) => {
                      const reference = TOOL_REFERENCES[id];
                      return reference && <p className="small" key={id}><DocLink href={reference.href}>{reference.label}</DocLink></p>;
                    })}
                  </details>
                );
              })}
              <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
                New task
              </Button>
            </section>

            <section className="config-block">
              <div className="config-title">
                <h2>
                  Models <span className="count">{chosenModels.length}</span>
                </h2>
                <span className="config-links">
                  <button type="button" onClick={() => setModels(chat.map((m) => m.id))}>
                    All
                  </button>
                  <button type="button" onClick={() => setModels([])}>
                    None
                  </button>
                </span>
              </div>
              <ModelChips value={chosenModels} onChange={setModels} />
            </section>

            <section className="config-block">
              <div className="config-title">
                <h2>Options</h2>
              </div>
              <div className="option">
                <span>Examples per task</span>
                <Segmented size="sm" label="Examples per task" value={limit} onChange={setLimit} options={[{ value: "5", label: "First 5" }, { value: "all", label: "All" }]} />
              </div>
              <div className="option">
                <span>Reasoning</span>
                <Segmented
                  size="sm"
                  label="Reasoning"
                  value={reasoning}
                  onChange={setReasoning}
                  options={[
                    { value: "off", label: "Off" },
                    { value: "default", label: "Default", title: "Each model does what it does by default" },
                    { value: "on", label: "On" },
                  ]}
                />
              </div>
              <p className="field-hint">
                Temperature 0 · up to {reasoning === "off" ? "1,024" : "4,096"} output tokens per answer, including reasoning.
              </p>
            </section>
          </div>

          <div className="config-run">
            {error && <Callout tone="red">{error}</Callout>}
            {running ? (
              <Button variant="danger" size="lg" icon={<Square size={14} />} onClick={() => {
                setError(null);
                api(`/evals/runs/${run!.id}/stop`, { method: "POST" })
                  .catch((e: Error) => setError(`Could not stop the run. ${e.message}`));
              }}>
                Stop run
              </Button>
            ) : (
              <Button variant="primary" size="lg" icon={starting ? <Spinner /> : <Play size={16} />} disabled={!requests || starting} onClick={start}>
                {starting ? "Starting run…" : requests ? `Run ${requests} ${caseUnits}` : "Choose tasks and models"}
              </Button>
            )}
          </div>
        </aside>

        <section className="results" aria-label="Results">
          {runError && <Callout tone="red">{runError}</Callout>}
          {pollError && <Callout tone="red">{pollError}</Callout>}
          {!run ? (
            <Card className="eval-preview">
              <header>
                <h2>Run preview</h2>
                <p className="muted">Each selected model answers the same set of examples.</p>
                {requested && runs.length > 0 && <Button size="sm" onClick={() => showRun(runs[0].id)}>Open latest saved run</Button>}
              </header>
              <dl className="eval-preview-stats">
                <div><dt>{caseUnits === "cases" ? "Cases" : "Requests"}</dt><dd>{requests}</dd></div>
                <div><dt>Models</dt><dd>{chosenModels.length}</dd></div>
                <div><dt>Tasks</dt><dd>{chosenTasks.length}</dd></div>
              </dl>
              {chosenTasks.length ? (
                <table className="eval-preview-tasks">
                  <thead><tr><th>Task</th><th>Grader</th><th>Examples per model</th></tr></thead>
                  <tbody>
                    {chosenTasks.map((task) => (
                      <tr key={task.id}>
                        <th scope="row">{task.name}</th>
                        <td>{GRADER_LABEL[task.grader] ?? task.grader}</td>
                        <td>{perTask(task)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="eval-preview-empty">Select a task in Run setup to add examples.</p>}
            </Card>
          ) : (
            <>
              <header className="results-head">
                <div className="results-title">
                  <h2>Leaderboard</h2>
                  {running ? (
                    <Badge tone="blue">
                      <Spinner size={11} /> Running
                    </Badge>
                  ) : (
                    <Badge tone={run.status === "done" ? "green" : "orange"}>{run.status === "done" ? "Complete" : "Stopped"}</Badge>
                  )}
                  {run.rate_limit_wait_ms > 0 && (
                    <Badge tone="orange" title="The endpoint returned 429. Every request waits, then the run continues.">
                      Rate limit reached. Resuming in {Math.ceil(run.rate_limit_wait_ms / 1000)} s
                    </Badge>
                  )}
                  <span className="muted small">
                    {run.models.length} models · {run.tasks.length} tasks
                  </span>
                  <Badge title="Reasoning mode requested for this run">Reasoning {reasoningLabel(run.reasoning)}</Badge>
                </div>
                <div className="results-actions">
                  {runs.length > 0 && <label className="eval-history-label">Saved runs
                    <select
                      value={run.id}
                      disabled={starting}
                      onChange={(e) => showRun(e.target.value, baseline)}
                    >
                      {runs.map((r) => (
                        <option key={r.id} value={r.id}>
                          {runLabel(r)}
                        </option>
                      ))}
                    </select>
                  </label>}
                  {runs.length > 1 && <Button size="sm" icon={<Columns2 size={14} />} aria-pressed={!!baseline}
                    onClick={() => showRun(run.id, baseline ? null : runs.find(r => r.id !== run.id)?.id)}>
                    {baseline ? "Close comparison" : "Compare runs"}
                  </Button>}
                  <a className="btn btn-secondary btn-sm" href={`/api/evals/runs/${run.id}/export`} download>
                    <Download size={14} /> Export JSON
                  </a>
                </div>
              </header>
              {baseline && baseline !== run.id && (!requested || run.id === requested) &&
                <RunComparison key={`${run.id}/${baseline}`} selected={run} baseline={baseline} runs={runs} choose={id => showRun(run.id, id)} />}
              {running && <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done} aria-label="Run progress">
                <span style={{ width: `${(run.done / Math.max(run.total, 1)) * 100}%` }} className={cx(running && "is-live")} />
              </div>}
              <Results key={run.id} run={run} onCell={openAnswers} />
              {cell && <Answers key={JSON.stringify([run.id, cell.model, cell.task])} run={run} cell={cell} onClose={() => openAnswers(null)} />}
            </>
          )}
        </section>
      </div>

      <NewTask
        open={creating}
        onClose={() => setCreating(false)}
        graders={graders}
        onSaved={(task) => {
          setTasks([...tasks, task]);
          setPicked([...picked, task.id]);
        }}
      />
    </div>
  );
}
