import { Code2, Download, Maximize2, Monitor, Play, Plus, Smartphone, Square, Tablet, Trash2, TriangleAlert, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DocLink } from "../components/DocLink";
import { ModelChips } from "../components/ModelPicker";
import { Badge, Button, Callout, Card, CopyButton, Modal, Segmented, Spinner, Stars } from "../components/ui";
import { api, type Build, type BuildSummary, type Challenge, type Reasoning, type Site } from "../lib/api";
import { docs } from "../lib/docs";
import { ago, bytes, cx, duration, load, num, save } from "../lib/format";
import { maker, ModelMark, useModels } from "../lib/models";
import "../styles/websites.css";

const DIFFICULTY = ["easy", "medium", "hard", "very hard", "expert"];
const TONE: Record<string, "neutral" | "blue" | "navy" | "orange"> = {
  easy: "neutral",
  medium: "neutral",
  hard: "blue",
  "very hard": "navy",
  expert: "orange",
};
const VIEW = { w: 1280, h: 800 };

const htmlUrl = (build: Build, site: Site) => `/api/sites/builds/${build.id}/${site.id}/html`;
type ReviewChange = Partial<Pick<Site, "stars" | "checks" | "notes">>;
type RepairReasoning = Exclude<Reasoning, "default">;

/** The frame runs inline scripts in an isolated origin. The response CSP blocks fetches and external subresources. */
function Preview({ src, title }: { src: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / VIEW.w));
    observer.observe(box.current!);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box} className="preview" style={{ height: VIEW.h * scale }}>
      <iframe
        src={src}
        title={title}
        sandbox="allow-scripts"
        loading="lazy"
        style={{ width: VIEW.w, height: VIEW.h, transform: `scale(${scale})` }}
      />
    </div>
  );
}

function statusBadge(site: Site, repaired: boolean) {
  if (site.status === "queued") return <Badge>Queued</Badge>;
  if (site.status === "writing") {
    return (
      <Badge tone="blue">
        <Spinner size={11} /> {site.chars ? "Writing" : site.thinking_chars ? "Reasoning" : "Waiting"}
      </Badge>
    );
  }
  if (site.status === "done") {
    if (!site.complete) return <Badge tone="orange" title="The saved HTML is incomplete">Partial</Badge>;
    return <Badge tone="green">{repaired ? "Edited" : "Generated"}</Badge>;
  }
  if (site.status === "stopped") return <Badge tone="orange">Stopped</Badge>;
  return <Badge tone="red">Error</Badge>;
}

function TokenMetrics({ site }: { site: Site }) {
  const count = site.reasoning_tokens;
  const pending = site.status === "queued" || site.status === "writing";
  const partial = count != null && site.reasoning_tokens_complete === false;
  const reasoning = count == null ? (pending ? "Pending" : "Not reported") : `${partial ? "≥" : ""}${num(count)}`;
  return (
    <>
      <div title="Completion tokens reported by the endpoint, including reasoning.">
        <dt>Total output tokens</dt><dd>{site.completion_tokens > 0 ? num(site.completion_tokens) : "–"}</dd>
      </div>
      <div title={partial ? "Reported so far. Some replies have no reasoning-token count." : undefined}>
        <dt>Reasoning tokens</dt><dd>{reasoning}</dd>
      </div>
    </>
  );
}

function SiteCard({
  build,
  site,
  onOpen,
  onSource,
  onStars,
}: {
  build: Build;
  site: Site;
  onOpen: () => void;
  onSource: () => void;
  onStars: (stars: number) => void;
}) {
  const working = site.status === "queued" || site.status === "writing";
  const elapsed = working && site.started ? (Date.now() / 1000 - site.started) * 1000 : site.total_ms;
  return (
    <Card as="article" className="site">
      <header className="site-head">
        <ModelMark id={site.model} size={30} />
        <div className="site-name">
          <h3 className="mono">{site.model}</h3>
          <span className="muted small">{maker(site.model)}</span>
        </div>
        {statusBadge(site, !!build.repair)}
      </header>

      <div className="site-body">
        {working ? (
          <div className="site-stream" aria-live="off">
            <div className="site-stream-top">
              <span>
                {site.chars
                  ? `${num(site.chars)} characters of ${build.repair ? "edits" : "HTML"}`
                  : site.thinking_chars
                    ? `Reasoning first: ${num(site.thinking_chars)} characters`
                    : "Waiting for the first token"}
              </span>
              <span>{duration(elapsed)}</span>
            </div>
            <pre>
              <code>{site.tail}</code>
              <span className="caret" />
            </pre>
          </div>
        ) : site.bytes > 0 ? (
          <Preview src={htmlUrl(build, site)} title={`Page written by ${site.model}`} />
        ) : (
          <div className="site-failed">
            <TriangleAlert size={20} />
            <p>{site.error ?? "Stopped before any HTML was written."}</p>
          </div>
        )}
      </div>

      <footer className="site-foot">
        <dl className="website-metrics">
          <div><dt>Time</dt><dd>{duration(elapsed)}</dd></div>
          <TokenMetrics site={site} />
          <div><dt>Tok/s</dt><dd>{site.tokens_per_second ? Math.round(site.tokens_per_second) : "–"}</dd></div>
          {site.bytes > 0 && <div><dt>File size</dt><dd>{bytes(site.bytes)}</dd></div>}
        </dl>
        {!working && site.status !== "done" && site.bytes > 0 && !site.complete && (
          <Badge tone="orange" title="The saved HTML is incomplete">Incomplete</Badge>
        )}
        {site.error && site.bytes > 0 && <Badge tone="red" title={site.error}>{build.repair ? "Repair error" : "Request error"}</Badge>}
        {!working && site.bytes > 0 && (
          <div className="site-actions">
            <Stars value={site.stars} onChange={onStars} label={`Your rating for ${site.model}`} />
            <span className="spacer" />
            <Button size="sm" icon={<Maximize2 size={14} />} onClick={onOpen}>
              Open
            </Button>
            <Button size="sm" variant="ghost" icon={<Code2 size={14} />} onClick={onSource} aria-label="View source" title="View source" />
            <a className="btn btn-ghost btn-sm btn-icon" href={`${htmlUrl(build, site)}?download=true`} aria-label="Download HTML" title="Download HTML">
              <Download size={14} />
            </a>
          </div>
        )}
      </footer>
    </Card>
  );
}

function Review({
  build,
  site,
  onClose,
  onReview,
  onRepair,
  starting,
  error,
}: {
  build: Build;
  site: Site;
  onClose: () => void;
  onReview: (site: Site, change: ReviewChange) => void;
  onRepair: (site: Site, feedback: string, reasoning: RepairReasoning) => void;
  starting: boolean;
  error: string | null;
}) {
  const [width, setWidth] = useState<"phone" | "tablet" | "desktop">("desktop");
  const [notes, setNotes] = useState(site.notes);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [repairReasoning, setRepairReasoning] = useState<RepairReasoning>(build.reasoning === "on" ? "on" : "off");
  const repairFeedback = feedback ?? notes;
  const checks = build.challenge.checks;
  const met = checks.filter((_, i) => site.checks[i]).length;
  function saveNotes() {
    if (notes !== site.notes) onReview(site, { notes });
  }
  return (
    <Modal open onClose={() => { saveNotes(); onClose(); }} full title={<><span className="mono">{site.model}</span>{build.repair && <> · Assisted repair</>}</>}>
      <div className="review">
        <div className="review-stage">
          <div className="review-bar">
            <Segmented
              size="sm"
              label="Preview width"
              value={width}
              onChange={setWidth}
              options={[
                { value: "phone", label: <><Smartphone size={14} /> 390</> },
                { value: "tablet", label: <><Tablet size={14} /> 820</> },
                { value: "desktop", label: <><Monitor size={14} /> Full</> },
              ]}
            />
            <span className="muted small">Inline scripts run in an isolated frame. The preview blocks fetch requests and external assets.</span>
          </div>
          <div className={cx("review-frame", `is-${width}`)}>
            <iframe src={htmlUrl(build, site)} title={`Page written by ${site.model}`} sandbox="allow-scripts" />
          </div>
        </div>
        <aside className="review-side">
          {error && <Callout tone="red">{error}</Callout>}
          {build.repair && site.error && <Callout tone="orange" title="Repair error">{site.error}</Callout>}
          <h3>Your rating</h3>
          <Stars value={site.stars} onChange={(stars) => onReview(site, { stars })} label="Your rating" />
          <dl className="facts">
            <div><dt>Time</dt><dd>{duration(site.total_ms)}</dd></div>
            <div><dt>First token</dt><dd>{duration(site.ttft_ms)}</dd></div>
            <TokenMetrics site={site} />
            <div><dt>Speed</dt><dd>{site.tokens_per_second ? `${Math.round(site.tokens_per_second)} tok/s` : "–"}</dd></div>
            <div><dt>File size</dt><dd>{bytes(site.bytes)}</dd></div>
            <div><dt>{build.repair ? "Model replies" : "Replies joined"}</dt><dd>{site.parts}</dd></div>
          </dl>
          <DocLink href={docs.reasoning}>How reasoning tokens count toward output</DocLink>
          {!site.complete && (
            <Callout tone="orange">The saved source is incomplete. Open the source to see what the model returned.</Callout>
          )}
          <details className="website-repair">
            <summary>Repair this page</summary>
            <form aria-busy={starting} onSubmit={(event) => {
              event.preventDefault();
              if (repairFeedback.trim() && !starting) onRepair(site, repairFeedback.trim(), repairReasoning);
            }}>
              <p className="muted small">Send this page and your feedback to {site.model} for a separate build.</p>
              <label className="field">
                <span className="field-label">Browser feedback</span>
                <textarea
                  required
                  disabled={starting}
                  rows={4}
                  maxLength={2000}
                  value={repairFeedback}
                  placeholder="Which action failed? What did you see, and what should happen?"
                  onChange={(event) => setFeedback(event.target.value)}
                />
              </label>
              <div className="website-repair-actions">
                <label className="field">
                  <span className="field-label">Repair reasoning</span>
                  <select disabled={starting} value={repairReasoning} onChange={(event) => setRepairReasoning(event.target.value === "on" ? "on" : "off")}>
                    <option value="off">Off</option>
                    <option value="on">On</option>
                  </select>
                </label>
                <Button type="submit" variant="primary" disabled={starting || !repairFeedback.trim()} icon={starting ? <Spinner /> : <Wrench size={14} />}>
                  {starting ? "Starting repair" : "Start repair"}
                </Button>
              </div>
            </form>
          </details>
          {checks.length > 0 && (
            <>
              <h3>
                Acceptance checks <span className="count">{met}/{checks.length}</span>
              </h3>
              <p className="muted small">Try each one in the page and tick what works. These are your judgments.</p>
              <ul className="checks">
                {checks.map((check, i) => (
                  <li key={i}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!site.checks[i]}
                        onChange={(e) => onReview(site, { checks: { ...site.checks, [i]: e.target.checked } })}
                      />
                      <span>{check}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3><label htmlFor="website-review-notes">Notes</label></h3>
          <textarea
            id="website-review-notes"
            rows={4}
            maxLength={2000}
            value={notes}
            placeholder="What worked, what broke"
            onChange={(e) => setNotes(e.target.value)}
            onBlur={saveNotes}
          />
        </aside>
      </div>
    </Modal>
  );
}

export function Websites() {
  const { chat } = useModels();
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [maxModels, setMaxModels] = useState(4);
  const [challenge, setChallenge] = useState<string>("launch_page");
  const [prompt, setPrompt] = useState("");
  const [models, setModels] = useState<string[]>(() => load("sites.models", []));
  const [reasoning, setReasoning] = useState<Reasoning>("off");
  const [savedBuild, setBuild] = useState<Build | null>(null);
  const [builds, setBuilds] = useState<BuildSummary[]>([]);
  const [setup, setSetup] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [source, setSource] = useState<{ site: Site; html: string | null; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const viewRequest = useRef(0);
  const listRequest = useRef(0);
  const reviewQueue = useRef(Promise.resolve());
  const [pendingReviews, setPendingReviews] = useState<{ buildId: string; siteId: string; change: ReviewChange }[]>([]);
  const build = savedBuild && {
    ...savedBuild,
    sites: savedBuild.sites.map((site) => pendingReviews.reduce((updated, review) =>
      review.buildId === savedBuild.id && review.siteId === site.id ? { ...updated, ...review.change } : updated, site)),
  };

  const selectBuild = useCallback(async (id: string, siteId?: string) => {
    const request = ++viewRequest.current;
    setError(null);
    setOpen(null);
    setSource(null);
    try {
      const next = await api<Build>(`/sites/builds/${id}`);
      if (request !== viewRequest.current) return;
      setBuild(next);
      setSetup(false);
      if (siteId && next.sites.some((site) => site.id === siteId && site.bytes > 0)) setOpen(siteId);
    } catch (e) {
      if (request === viewRequest.current) setError(`Could not open the build. ${(e as Error).message}`);
    }
  }, []);

  const loadBuilds = useCallback(async (initial = false) => {
    const request = ++listRequest.current;
    const view = viewRequest.current;
    try {
      const data = await api<{ builds: BuildSummary[] }>("/sites/builds");
      if (request !== listRequest.current) return;
      setBuilds(data.builds);
      if (initial && view === viewRequest.current && data.builds[0]) void selectBuild(data.builds[0].id);
    } catch (e) {
      if (request === listRequest.current) setError(`Could not load build history. ${(e as Error).message}`);
    }
  }, [selectBuild]);

  useEffect(() => {
    let active = true;
    api<{ challenges: Challenge[]; max_models: number }>("/sites/challenges").then((d) => {
      if (!active) return;
      setChallenges(d.challenges);
      setMaxModels(d.max_models);
      setPrompt((current) => current || d.challenges.find((c) => c.id === "launch_page")?.prompt || "");
    }).catch((e: Error) => {
      if (active) setError(`Could not load challenges. ${e.message}`);
    });
    void loadBuilds(true);
    return () => {
      active = false;
      listRequest.current++;
      viewRequest.current++;
    };
  }, [loadBuilds]);

  // Start with one model from each of the first three makers.
  useEffect(() => {
    const ids = chat.map((m) => m.id);
    if (!ids.length) return;
    const kept = models.filter((id) => ids.includes(id));
    if (kept.length) {
      if (kept.length !== models.length) setModels(kept);
      return;
    }
    const seen = new Set<string>();
    setModels(ids.filter((id) => !seen.has(maker(id)) && seen.add(maker(id))).slice(0, 3));
    // Only when the model list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat]);
  useEffect(() => {
    if (models.length) save("sites.models", models);
  }, [models]);

  // The build runs on the server. Ask how it is going while it works.
  useEffect(() => {
    setPollError(null);
    if (!savedBuild?.running) return;
    const id = savedBuild.id;
    let active = true;
    let timer = window.setTimeout(poll, 700);
    async function poll() {
      try {
        const next = await api<Build>(`/sites/builds/${id}`);
        if (!active) return;
        setBuild((current) => current?.id === id ? next : current);
        if (!next.running) void loadBuilds();
      } catch (e) {
        if (!active) return;
        setPollError(`Could not refresh the build. Retrying. ${(e as Error).message}`);
        timer = window.setTimeout(poll, 2000);
      }
    }
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [savedBuild, loadBuilds]);

  async function start() {
    if (starting) return;
    viewRequest.current++;
    setStarting(true);
    setError(null);
    try {
      const next = await api<Build>("/sites/builds", { body: { models, prompt, challenge, reasoning } });
      setBuild({ ...next, running: true });
      setOpen(null);
      setSource(null);
      setSetup(false);
      void loadBuilds();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function repair(site: Site, feedback: string, mode: RepairReasoning) {
    if (!build || starting) return;
    const request = ++viewRequest.current;
    setStarting(true);
    setError(null);
    try {
      const next = await api<{ id: string }>(`/sites/builds/${build.id}/${site.id}/repair`, {
        body: { feedback, reasoning: mode },
      });
      if (request === viewRequest.current) void selectBuild(next.id);
      void loadBuilds();
    } catch (e) {
      if (request === viewRequest.current) setError(`Could not start the repair. ${(e as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  function review(site: Site, change: ReviewChange) {
    if (!build) return;
    const pending = { buildId: build.id, siteId: site.id, change };
    setError(null);
    setPendingReviews((list) => [...list, pending]);
    // Commit rapid edits in order. Remove each optimistic change after the server replies.
    reviewQueue.current = reviewQueue.current.then(async () => {
      try {
        const saved = await api<Site>(`/sites/builds/${build.id}/${site.id}/review`, { method: "PUT", body: change });
        setBuild((current) => current?.id === build.id ? {
          ...current, sites: current.sites.map((s) => s.id === site.id ? saved : s),
        } : current);
      } catch (e) {
        setError(`Could not save the review for ${site.model}. ${(e as Error).message}`);
      } finally {
        setPendingReviews((list) => list.filter((item) => item !== pending));
      }
    });
  }

  async function showSource(site: Site) {
    if (!build) return;
    const loading = { site, html: null };
    setSource(loading);
    try {
      const response = await fetch(htmlUrl(build, site));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      setSource((current) => current === loading ? { site, html } : current);
    } catch (e) {
      setSource((current) => current === loading ? { ...loading, error: `Could not load the HTML. ${(e as Error).message}` } : current);
    }
  }

  async function stopBuild() {
    if (!build) return;
    setError(null);
    try {
      await api(`/sites/builds/${build.id}/stop`, { method: "POST" });
    } catch (e) {
      setError(`Could not stop the build. ${(e as Error).message}`);
    }
  }

  async function deleteBuild() {
    if (!build || !confirm("Delete this build and its pages?")) return;
    const view = viewRequest.current;
    setError(null);
    try {
      await api(`/sites/builds/${build.id}`, { method: "DELETE" });
      if (view === viewRequest.current) {
        viewRequest.current++;
        setBuild(null);
        setSetup(true);
        setOpen(null);
        setSource(null);
      }
      void loadBuilds();
    } catch (e) {
      setError(`Could not delete the build. ${(e as Error).message}`);
    }
  }

  const current = challenges.find((c) => c.id === challenge);
  const edited = !!current && current.prompt.trim() !== prompt.trim();
  const openSite = build?.sites.find((s) => s.id === open) ?? null;
  const sourcePage = build?.repair;

  return (
    <div className="websites">
      <header className="toolbar">
        <div>
          <h1>Websites</h1>
          <p className="muted">Give up to {maxModels} models one brief and compare their pages side by side.</p>
        </div>
        <div className="toolbar-actions">
          {builds.length > 0 && <label className="website-history">
            Earlier builds
            <select
              aria-label="Earlier builds"
              value={build?.id ?? ""}
              disabled={starting}
              onChange={(e) => void selectBuild(e.target.value)}
            >
              {!build && <option value="">Choose a build</option>}
              {builds.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} · {b.repair
                    ? `Assisted repair · ${b.sites[0].model}`
                    : b.sites.length === 1 ? b.sites[0].model : `${b.sites.length} models`}{b.reasoning && ` · reasoning ${b.reasoning}`} · {ago(b.started)}
                </option>
              ))}
            </select>
          </label>}
          {!setup && (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => {
              viewRequest.current++;
              setError(null);
              setSetup(true);
            }}>
              New build
            </Button>
          )}
        </div>
      </header>

      {error && !openSite && <Callout tone="red">{error}</Callout>}
      {pollError && <Callout tone="red">{pollError}</Callout>}

      {setup && (
        <Card className="website-setup">
          <div className="website-brief">
            <div className="website-section-title">
              <h2><label htmlFor="website-challenge">Build challenge</label></h2>
              {current && !edited && <Badge tone={TONE[current.difficulty]}>{current.difficulty}</Badge>}
            </div>
            <select id="website-challenge" value={challenge} onChange={(e) => {
              const selected = challenges.find((c) => c.id === e.target.value);
              if (selected) {
                setChallenge(selected.id);
                setPrompt(selected.prompt);
              }
            }}>
              {DIFFICULTY.map((difficulty) => (
                <optgroup key={difficulty} label={difficulty[0].toUpperCase() + difficulty.slice(1)}>
                  {challenges.filter((c) => c.difficulty === difficulty).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <label className="field">
              <span className="field-label">
                Build prompt
              </span>
              <textarea rows={7} maxLength={12000} aria-describedby={prompt.trim().length < 10 ? "website-prompt-hint" : undefined}
                value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            {prompt.trim().length < 10 && <p className="field-hint" id="website-prompt-hint">Describe the page in at least 10 characters.</p>}
            {edited ? (
              <div className="website-custom">
                <span>Custom prompts skip the preset checks.</span>
                <Button size="sm" variant="ghost" onClick={() => setPrompt(current.prompt)}>Restore prompt</Button>
              </div>
            ) : current && current.checks.length > 0 && (
              <details className="website-criteria">
                <summary>Acceptance checks ({current.checks.length})</summary>
                <ul>{current.checks.map((check) => <li key={check}>{check}</li>)}</ul>
              </details>
            )}
          </div>
          <div className="website-controls">
            <div className="website-section-title">
              <h2>Choose models</h2>
              <span className="website-selected">{models.length} / {maxModels} selected</span>
            </div>
            <ModelChips value={models} onChange={setModels} max={maxModels} />
            <div className="website-reasoning">
              <h3>Reasoning</h3>
              <Segmented
                size="sm"
                label="Reasoning"
                value={reasoning}
                onChange={setReasoning}
                options={[
                  { value: "off", label: "Off" },
                  { value: "default", label: "Default" },
                  { value: "on", label: "On" },
                ]}
              />
              <span className="field-hint">
                {reasoning === "on" && "Thinking uses part of the reply budget before the model writes HTML. "}
                <DocLink href={docs.reasoning}>Akamai’s reasoning guide</DocLink>
              </span>
            </div>
            <div className="setup-buttons">
              {build && <Button disabled={starting} onClick={() => setSetup(false)}>Cancel</Button>}
              <Button variant="primary" size="lg" icon={starting ? <Spinner /> : <Play size={16} />} disabled={starting || !models.length || prompt.trim().length < 10 || build?.running} onClick={start}>
                {starting ? "Starting build" : !models.length ? "Choose a model to generate a page" : `Generate ${models.length} ${models.length === 1 ? "page" : "pages"}`}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {build && (
        <section aria-label="Build">
          <header className="build-head">
            <div className="results-title">
              <h2>{build.challenge.name}</h2>
              {build.repair && <Badge tone="blue">Assisted repair</Badge>}
              {build.challenge.difficulty && <Badge tone={TONE[build.challenge.difficulty]}>{build.challenge.difficulty}</Badge>}
              <span className="muted small">
                {ago(build.started)} · reasoning {build.reasoning}
              </span>
            </div>
            <div className="results-actions">
              {sourcePage && (
                <Button size="sm" onClick={() => void selectBuild(sourcePage.build_id, sourcePage.site_id)}>
                  Open source page
                </Button>
              )}
              {build.running ? (
                <Button variant="danger" size="sm" icon={<Square size={12} />} onClick={stopBuild}>
                  Stop
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  disabled={starting}
                  onClick={deleteBuild}
                >
                  Delete
                </Button>
              )}
            </div>
          </header>
          <details className="build-prompt">
            <summary>Prompt</summary>
            <p>{build.prompt}</p>
          </details>
          {build.repair && (
            <details className="build-prompt">
              <summary>Repair feedback</summary>
              <p>{build.repair.feedback}</p>
            </details>
          )}
          <div className={cx("sites", `sites-${Math.min(build.sites.length, 4)}`)}>
            {build.sites.map((site) => (
              <SiteCard
                key={site.id}
                build={build}
                site={site}
                onOpen={() => {
                  viewRequest.current++;
                  setOpen(site.id);
                }}
                onSource={() => showSource(site)}
                onStars={(stars) => review(site, { stars })}
              />
            ))}
          </div>
          {openSite && (
            <Review
              key={`${build.id}/${openSite.id}`}
              build={build}
              site={openSite}
              error={error}
              starting={starting}
              onClose={() => {
                viewRequest.current++;
                setOpen(null);
              }}
              onReview={review}
              onRepair={repair}
            />
          )}
        </section>
      )}

      <Modal
        open={!!source}
        onClose={() => setSource(null)}
        wide
        title={<span className="mono">{source?.site.model}.html</span>}
        footer={source?.html ? <CopyButton text={source.html} label="Copy HTML" /> : undefined}
      >
        {source?.error ? (
          <Callout tone="red">{source.error}</Callout>
        ) : source?.html == null ? (
          <Spinner />
        ) : (
          <pre className="code-block code-tall">
            <code>{source.html}</code>
          </pre>
        )}
      </Modal>
    </div>
  );
}
