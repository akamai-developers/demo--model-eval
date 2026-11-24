import { useEffect, useState } from "react";
import { api, type EvalRunSummary, type Reasoning } from "../lib/api";
import { duration, num } from "../lib/format";
import { Badge, Callout, Card, Spinner } from "./ui";

export function reasoningLabel(mode: Reasoning | null | undefined) {
  if (mode === "default") return "Model default";
  if (mode === "on") return "On";
  if (mode === "off") return "Off";
  return "Not recorded";
}

export function runLabel(run: EvalRunSummary) {
  const date = new Date(run.started * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
  });
  const tasks = run.tasks.length > 1 ? `${run.tasks[0]} +${run.tasks.length - 1}` : run.tasks[0];
  const models = run.models.length === 1 ? run.models[0] : `${run.models.length} models`;
  return `${tasks} · ${models} · Reasoning ${reasoningLabel(run.reasoning)} · ${date} · ${run.status === "done" ? "complete" : run.status}`;
}

interface PairedStats { passed: number; median_ms: number | null; tokens: number | null }
interface Comparison {
  running: boolean;
  rows: {
    model: string; shared: number; baseline_done: number; selected_done: number;
    baseline: PairedStats; selected: PairedStats; improved: number; regressed: number;
    tool_pairs: number; baseline_right_tool: number; selected_right_tool: number;
  }[];
}

export function RunComparison({ selected, baseline, runs, choose }: {
  selected: Pick<EvalRunSummary, "id" | "reasoning">; baseline: string; runs: EvalRunSummary[]; choose: (id: string) => void;
}) {
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState<"passes" | "tool" | "tokens" | "time">("passes");
  const other = runs.find(r => r.id === baseline);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function fetchComparison() {
      try {
        const result = await api<Comparison>(`/evals/runs/${encodeURIComponent(selected.id)}/compare/${encodeURIComponent(baseline)}`);
        if (!active) return;
        setData(result);
        setError("");
        if (result.running) timer = setTimeout(fetchComparison, 1500);
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    }
    fetchComparison();
    return () => { active = false; clearTimeout(timer); };
  }, [baseline, selected.id]);

  function value(stats: PairedStats, shared: number) {
    if (!shared) return "–";
    if (metric === "tokens") return num(stats.tokens);
    if (metric === "time") return duration(stats.median_ms);
    return `${stats.passed} / ${shared}`;
  }

  const paired = data?.rows.reduce((n, row) => n + row.shared, 0) ?? 0;
  const toolPairs = data?.rows.reduce((n, row) => n + row.tool_pairs, 0) ?? 0;
  return (
    <Card className="run-comparison" aria-label="Run comparison">
      <div className="compare-head">
        <h2>Run comparison</h2>
        <label>Baseline run
          <select value={baseline} onChange={e => choose(e.target.value)}>
            {runs.filter(r => r.id !== selected.id).map(r => <option key={r.id} value={r.id}>{runLabel(r)}</option>)}
          </select>
        </label>
      </div>
      {error && <Callout tone="red">{error}</Callout>}
      {!data && !error && <Spinner />}
      {data && <>
        <div className="compare-controls">
          <p>{num(paired)} matching {paired === 1 ? "result" : "results"} across both runs</p>
          {paired > 0 && <label>Metric
            <select value={metric} onChange={e => setMetric(e.target.value as typeof metric)}>
              <option value="passes">Pass count</option>
              {toolPairs > 0 && <option value="tool">Correct tool choice</option>}
              <option value="tokens">Output tokens</option><option value="time">Median time per example</option>
            </select>
          </label>}
        </div>
        {paired > 0 && <div className="table-scroll"><table className="pair-table">
          <thead><tr><th>Model</th><th>Matched</th><th>Baseline <Badge>Reasoning {reasoningLabel(other?.reasoning)}</Badge></th>
            <th>Selected <Badge>Reasoning {reasoningLabel(selected.reasoning)}</Badge></th>
            {metric === "passes" && <th>Changed outcomes</th>}</tr></thead>
          <tbody>{data.rows.filter(row => (metric === "tool" ? row.tool_pairs : row.shared) > 0).map(row => <tr key={row.model}>
            <th scope="row" className="mono">{row.model}</th><td>{metric === "tool" ? row.tool_pairs : row.shared}</td>
            <td>{metric === "tool" ? `${row.baseline_right_tool} / ${row.tool_pairs}` : value(row.baseline, row.shared)}</td>
            <td>{metric === "tool" ? `${row.selected_right_tool} / ${row.tool_pairs}` : value(row.selected, row.shared)}</td>
            {metric === "passes" && <td>{row.improved || row.regressed
              ? [row.improved && `${row.improved} gained`, row.regressed && `${row.regressed} lost`].filter(Boolean).join(", ")
              : "No change"}</td>}
          </tr>)}</tbody>
        </table></div>}
        <p className="table-note">{metric === "tool" && `Tool choice is scorable on both sides for ${num(toolPairs)} matching results. `}{paired ? "Only completed results with the same model, task, input, grader and expected answer are paired." : "These runs have no completed examples in common for the same model."}{" "}
          Baseline has {num(data.rows.reduce((n, r) => n + r.baseline_done - r.shared, 0))} unmatched results.
          Selected has {num(data.rows.reduce((n, r) => n + r.selected_done - r.shared, 0))}.</p>
      </>}
    </Card>
  );
}
