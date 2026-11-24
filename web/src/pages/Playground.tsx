import { ArrowUp, ArrowUpRight, Braces, ChevronRight, Code2, Cpu, Pencil, Plus, Puzzle, Settings2, Square, Table2, Trash2, X, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DocLink } from "../components/DocLink";
import { Markdown } from "../components/Markdown";
import { ModelSelect } from "../components/ModelPicker";
import { AttachmentList, AttachmentPicker } from "../components/PlaygroundAttachments";
import { Badge, Button, Callout, CopyButton, Drawer, Field, Modal, Segmented } from "../components/ui";
import { streamChat, type ChatBody, type Metrics } from "../lib/api";
import { userContent, type Attachment } from "../lib/attachments";
import { changeModel, DEFAULTS, type Lane, type Turn } from "../lib/playgroundSessions";
import { usePlaygroundSessions } from "../lib/usePlaygroundSessions";
import { curlSnippet, nodeSnippet, pythonSnippet } from "../lib/code";
import { docs } from "../lib/docs";
import { cx, duration, load, num, save } from "../lib/format";
import { maker, useModels } from "../lib/models";
import "../styles/playground.css";

const MAX_LANES = 4;

const STARTERS = [
  { Icon: Cpu, prompt: "Explain what a KV cache does in an LLM server. Three sentences." },
  { Icon: Braces, prompt: "Write a Python function that retries an HTTP request with exponential backoff." },
  { Icon: Puzzle, prompt: "A farmer has 17 sheep. All but 9 run away. How many are left? Show your reasoning." },
  { Icon: Table2, prompt: "Compare REST and gRPC in a five-row table." },
];

function messagesFor(turns: Turn[]): ChatBody["messages"] {
  return turns.filter((turn, i) => {
    const reply = turns[i + 1];
    // A rejected or reasoning-only request has no assistant message to replay.
    if (turn.role === "user" && reply?.role === "assistant" && !reply.content) return false;
    return turn.content || turn.attachments?.length;
  }).map(turn => ({
    role: turn.role,
    content: turn.role === "user" ? userContent(turn.content, turn.attachments) : turn.content,
  }));
}

function Reasoning({ text, active }: { text: string; active: boolean }) {
  // Open while the model is still thinking, closed once the answer starts, and yours to toggle after that.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? active;
  return (
    <div className="reasoning">
      <button type="button" className="reasoning-toggle" aria-expanded={open} onClick={() => setChosen(!open)}>
        <ChevronRight size={14} className={cx(open && "rot")} aria-hidden="true" />
        {active ? "Thinking" : "Reasoning"} <span className="muted">{num(text.length)} characters</span>
      </button>
      {open && <div className="reasoning-text">{text}</div>}
    </div>
  );
}

function MetricsRow({ metrics, fastest }: { metrics: Metrics; fastest: boolean }) {
  return (
    <div className="reply-metrics">
      <dl>
        <div><dt>First token</dt><dd>{duration(metrics.ttft_ms)}</dd></div>
        <div><dt>Tokens/sec</dt><dd>{metrics.tokens_per_second ?? "–"}</dd></div>
        <div><dt>Tokens</dt><dd>{num(metrics.completion_tokens)}</dd></div>
        <div><dt>Total time</dt><dd>{duration(metrics.total_ms)}</dd></div>
      </dl>
      {fastest && (
        <Badge tone="orange">
          <Zap size={11} /> Fastest
        </Badge>
      )}
      {metrics.finish_reason === "length" && <Badge tone="orange">Cut off at max tokens</Badge>}
    </div>
  );
}

function LaneView({
  lane,
  canRemove,
  otherModels,
  busy,
  fastest,
  selected,
  setup,
  onModel,
  onRemove,
}: {
  lane: Lane;
  canRemove: boolean;
  otherModels: string[];
  busy: boolean;
  fastest: boolean;
  selected: boolean;
  setup: boolean;
  onModel: (id: string) => void;
  onRemove: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = lane.turns[lane.turns.length - 1];

  // Follow the reply as it streams, unless you scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [last?.content, last?.reasoning, lane.turns.length, selected]);

  return (
    <section className={cx("lane", selected && "is-selected")} aria-label={`Conversation with ${lane.model}`}>
      <header className="lane-head">
        <ModelSelect value={lane.model} onChange={onModel} disabled={busy} otherModels={otherModels} />
        {canRemove && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${lane.model}`}
            disabled={busy}
            icon={<X size={16} />}
            onClick={onRemove}
          />
        )}
      </header>
      {!setup && <div
        key={lane.model}
        className="lane-body"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {lane.turns.length === 0 && (
          <p className="lane-empty">This model will answer your next message.</p>
        )}
        {lane.turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} className="turn turn-user">
              {turn.content}
              {!!turn.attachments?.length && <AttachmentList attachments={turn.attachments} />}
            </div>
          ) : (
            <div key={i} className="turn turn-assistant">
              {turn.model !== lane.model && <span className="mono small">{turn.model}</span>}
              {turn.reasoning && (
                <Reasoning text={turn.reasoning} active={turn.status === "streaming" && !turn.content} />
              )}
              {turn.content ? (
                <Markdown text={turn.content} streaming={turn.status === "streaming"} />
              ) : (
                turn.status === "streaming" && !turn.reasoning && <span className="waiting" aria-label="Waiting for the first token" />
              )}
              {turn.status === "error" && <p className="turn-error">{turn.error}</p>}
              {turn.status === "stopped" && <p className="muted small">Stopped</p>}
              {turn.metrics && (
                <MetricsRow metrics={turn.metrics} fastest={fastest && i === lane.turns.length - 1} />
              )}
            </div>
          ),
        )}
      </div>}
    </section>
  );
}

export function Playground({ search }: { search: string }) {
  const { chat, baseUrl, loading } = useModels();
  const { session, setSession, labels, ready, switching, storageError, select, create, remove } = usePlaygroundSessions();
  const { lanes, settings, draft, selectedKey, attachments } = session;
  const setLanes = useCallback((update: Lane[] | ((lanes: Lane[]) => Lane[])) =>
    setSession(s => ({ ...s, lanes: typeof update === "function" ? update(s.lanes) : update })), [setSession]);
  const setDraft = (draft: string) => setSession(s => ({ ...s, draft }));
  const setAttachments = (attachments: Attachment[]) => setSession(s => ({ ...s, attachments }));
  const setSettings = (value: typeof settings) => setSession(s => ({ ...s, settings: value }));
  const setSelectedKey = (selectedKey: number) => setSession(s => ({ ...s, selectedKey }));
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const locked = busy || reading || switching || !ready;
  const [sessionAction, setSessionAction] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [language, setLanguage] = useState<"python" | "curl" | "node">("python");
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Start with two models from different makers, or with whatever was open last time.
  useEffect(() => {
    if (!ready || !chat.length || lanes.length) return;
    const ids = chat.map((m) => m.id);
    const saved = load<string[]>("playground.models", []).filter((id) => ids.includes(id));
    const second = ids.find((id) => maker(id) !== maker(ids[0])) ?? ids[1];
    const start = saved.length ? saved : [ids[0], second].filter(Boolean);
    setLanes(start.slice(0, MAX_LANES).map((model, i) => ({ key: i + 1, model, turns: [] })));
  }, [chat, lanes.length, ready, setLanes]);

  // "Try it" on the Models screen lands here with ?model=id.
  useEffect(() => {
    const wanted = new URLSearchParams(search).get("model");
    if (locked || !wanted || !lanes.length || !chat.some((m) => m.id === wanted)) return;
    if (session.title || lanes.some(lane => lane.turns.length || Object.keys(lane.previous ?? {}).length) || draft || attachments.length) {
      create([wanted]);
    } else {
      setLanes([{ key: lanes[0].key, model: wanted, turns: [] }]);
    }
    history.replaceState(null, "", "/playground");
    window.dispatchEvent(new PopStateEvent("popstate"));
    // Only when the query changes or the lanes first appear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, lanes.length > 0, chat.length, locked]);

  const modelIds = lanes.map(lane => lane.model).join("\n");
  useEffect(() => {
    if (modelIds) save("playground.models", modelIds.split("\n"));
  }, [modelIds]);

  const patchLast = useCallback((key: number, change: (turn: Turn) => Turn) => {
    setLanes((current) =>
      current.map((lane) =>
        lane.key === key ? { ...lane, turns: lane.turns.map((t, i) => (i === lane.turns.length - 1 ? change(t) : t)) } : lane,
      ),
    );
  }, []);

  const bodyFor = useCallback(
    (lane: Lane, prompt: string, files: Attachment[]): ChatBody => ({
      model: lane.model,
      messages: [
        ...messagesFor(lane.turns),
        { role: "user", content: userContent(prompt, files) },
      ],
      system: settings.system,
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
      top_p: null,
      reasoning: settings.reasoning,
    }),
    [settings],
  );

  async function send(text: string) {
    const prompt = text.trim();
    if ((!prompt && !attachments.length) || locked || !lanes.length || abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    const jobs = lanes.map((lane) => ({ lane, body: bodyFor(lane, prompt, attachments) }));
    const user: Turn = { role: "user", content: prompt, attachments };
    setSession(s => ({
      ...s, title: s.title || (prompt || attachments[0].name).replace(/\s+/g, " ").slice(0, 70), draft: "", attachments: [],
      lanes: jobs.map(({ lane, body }) => {
        const { messages: _messages, ...options } = body;
        return {
          ...lane, lastRequest: { ...options, turnCount: lane.turns.length + 1 },
          turns: [...lane.turns, user, { role: "assistant", model: lane.model, content: "", status: "streaming" }],
        };
      }),
    }));

    await Promise.all(
      jobs.map(async ({ lane: { key }, body }) => {
        // Tokens arrive faster than the screen needs to repaint. Collect them and paint once per frame.
        let content = "";
        let reasoning = "";
        let frame = 0;
        const flush = () => {
          frame = 0;
          const add = { content, reasoning };
          content = reasoning = "";
          patchLast(key, (t) => ({ ...t, content: t.content + add.content, reasoning: (t.reasoning ?? "") + add.reasoning }));
        };
        try {
          await streamChat(
            body,
            (event) => {
              if (event.type === "delta") {
                content += event.content;
                reasoning += event.reasoning;
                frame ||= requestAnimationFrame(flush);
              } else if (event.type === "done") {
                cancelAnimationFrame(frame);
                flush();
                const { type: _type, ...metrics } = event;
                patchLast(key, (t) => ({ ...t, status: "done", metrics }));
              } else {
                cancelAnimationFrame(frame);
                flush();
                patchLast(key, (t) => ({ ...t, status: "error", error: event.message }));
              }
            },
            controller.signal,
          );
        } catch (error) {
          cancelAnimationFrame(frame);
          flush();
          const stopped = controller.signal.aborted;
          patchLast(key, (t) =>
            t.status === "streaming"
              ? { ...t, status: stopped ? "stopped" : "error", error: stopped ? undefined : (error as Error).message }
              : t,
          );
        }
      }),
    );
    abort.current = null;
    setBusy(false);
    input.current?.focus();
  }

  // The fastest reply of the latest turn, when there is more than one to compare.
  const fastestKey = useMemo(() => {
    if (busy || lanes.length < 2) return null;
    const speeds = lanes.map((l) => ({ key: l.key, speed: l.turns[l.turns.length - 1]?.metrics?.tokens_per_second ?? 0 }));
    const best = speeds.reduce((a, b) => (b.speed > a.speed ? b : a));
    return best.speed > 0 && speeds.filter((s) => s.speed > 0).length > 1 ? best.key : null;
  }, [lanes, busy]);

  const hasTurns = lanes.some((l) => l.turns.length);
  const selectedLane = lanes.find((lane) => lane.key === selectedKey) ?? lanes[0];
  const addModel = (
    <Button
      size="sm"
      icon={<Plus size={15} />}
      disabled={lanes.length >= MAX_LANES || locked || !chat.some(m => !lanes.some(l => l.model === m.id))}
      onClick={() => {
        const used = lanes.map((lane) => lane.model);
        const makers = used.map(maker);
        const model = chat.find((m) => !makers.includes(maker(m.id))) ?? chat.find((m) => !used.includes(m.id));
        if (!model) return;
        const key = Math.max(0, ...lanes.map(lane => lane.key)) + 1;
        setLanes([...lanes, { key, model: model.id, turns: [] }]);
        setSelectedKey(key);
      }}
    >
      Add model
    </Button>
  );
  const savedRequest = !draft.trim() && !attachments.length ? selectedLane?.lastRequest : undefined;
  const codeBody = showCode && selectedLane
    ? savedRequest
      ? { ...savedRequest, messages: messagesFor(selectedLane.turns.slice(0, savedRequest.turnCount)) }
      : bodyFor(selectedLane, draft.trim() || (attachments.length ? "" : "Hello"), attachments)
    : null;
  const code = !codeBody
    ? ""
    : language === "python"
      ? pythonSnippet(baseUrl, codeBody)
      : language === "curl"
        ? curlSnippet(baseUrl, codeBody)
        : nodeSnippet(baseUrl, codeBody);

  return (
    <div className={cx("playground", hasTurns ? "pg-chatting" : "pg-setup")}>
      <header className="toolbar">
        <div>
          <h1>Playground</h1>
          <p className="muted">Compare how up to {MAX_LANES} models answer the same prompt.</p>
        </div>
        <div className="toolbar-actions">
          {hasTurns && addModel}
          <Button size="sm" icon={<Settings2 size={16} />} onClick={() => setShowSettings(true)}>
            Settings
          </Button>
          <Button size="sm" icon={<Code2 size={16} />} onClick={() => setShowCode(true)} disabled={!lanes.length}>
            View code
          </Button>
        </div>
      </header>

      <div className="pg-session-bar">
        <label className="pg-session-choice">
          <span>Session</span>
          <select aria-label="Session" value={session.id} onChange={e => void select(e.target.value)} disabled={locked}>
            {labels.map(label => <option key={label.id} value={label.id}>{label.title || "Untitled session"}</option>)}
          </select>
        </label>
        <Button size="sm" icon={<Plus size={15} />} onClick={() => create()} disabled={locked}>New session</Button>
        <Button size="sm" variant="ghost" icon={<Pencil size={15} />} aria-label="Rename session" title="Rename session"
          disabled={locked} onClick={() => { setName(session.title); setSessionAction("rename"); }} />
        <Button size="sm" variant="ghost" icon={<Trash2 size={15} />} aria-label="Delete session" title="Delete session"
          disabled={locked} onClick={() => setSessionAction("delete")} />
      </div>
      {storageError && <Callout tone="orange">{storageError}</Callout>}
      <div className="pg-workspace">
        <div className="pg-session">
          {!hasTurns && <div className="pg-section-head"><h2>Compare models</h2>{addModel}</div>}
          {hasTurns && lanes.length > 1 && <label className="pg-response-picker">
            <span>Read response</span>
            <select value={selectedLane.key} onChange={(e) => setSelectedKey(Number(e.target.value))}>
              {lanes.map((lane) => <option key={lane.key} value={lane.key}>{lane.model}</option>)}
            </select>
          </label>}
          <div className="lanes" style={{ gridTemplateColumns: `repeat(${Math.max(lanes.length, 1)}, minmax(0, 1fr))` }}>
            {!lanes.length && <p className="muted small">{loading ? "Loading chat models…" : "No chat models available."}</p>}
            {lanes.map((lane) => (
              <LaneView
                key={`${session.id}:${lane.key}`}
                lane={lane}
                busy={locked}
                canRemove={lanes.length > 1}
                otherModels={lanes.filter(l => l.key !== lane.key).map(l => l.model)}
                fastest={fastestKey === lane.key}
                selected={selectedLane.key === lane.key}
                setup={!hasTurns}
                onModel={(model) => setLanes(lanes.map((l) => (l.key === lane.key ? changeModel(l, model) : l)))}
                onRemove={() => setLanes(lanes.filter((l) => l.key !== lane.key))}
              />
            ))}
          </div>

          <div className="composer-wrap">
            {!hasTurns && <label className="pg-prompt-label" htmlFor="pg-prompt">Prompt</label>}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                send(draft);
              }}
            >
              <textarea
                id="pg-prompt"
                ref={input}
                value={draft}
                rows={Math.min(6, Math.max(hasTurns ? 1 : 4, draft.split("\n").length))}
                placeholder={hasTurns ? "Ask a follow-up…" : "What would you like the models to do?"}
                aria-label="Prompt"
                disabled={!ready || switching}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send(draft);
                  }
                }}
              />
              <AttachmentPicker key={session.id} attachments={attachments} onChange={setAttachments}
                onReadingChange={setReading} disabled={busy || switching || !ready} />
              <div className="pg-composer-actions">
                <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
                {busy ? (
                  <Button variant="danger" icon={<Square size={14} />} onClick={() => abort.current?.abort()}>
                    Stop
                  </Button>
                ) : (
                  <Button type="submit" variant="primary" icon={<ArrowUp size={16} />} disabled={locked || (!draft.trim() && !attachments.length) || !lanes.length}>
                    Send
                  </Button>
                )}
              </div>
            </form>
          </div>
        </div>
        {!hasTurns && <aside className="pg-examples" aria-label="Example prompts">
          <h2>Example prompts</h2>
          <div className="starters">
            {STARTERS.map(({ Icon, prompt }) => (
              <button key={prompt} type="button" className="starter" onClick={() => {
                setDraft(draft.trim() && !STARTERS.some(example => example.prompt === draft) ? `${draft.trimEnd()}\n\n${prompt}` : prompt);
                input.current?.focus();
              }} disabled={locked}>
                <Icon size={18} aria-hidden="true" /><span>{prompt}</span><ArrowUpRight size={14} aria-hidden="true" />
              </button>
            ))}
          </div>
        </aside>}
      </div>

      <Modal open={sessionAction === "rename"} onClose={() => setSessionAction(null)} title="Rename session">
        <form className="form" onSubmit={event => {
          event.preventDefault();
          if (!name.trim()) return;
          setSession(s => ({ ...s, title: name.trim() }));
          setSessionAction(null);
        }}>
          <Field label="Session name"><input autoFocus value={name} maxLength={100} onChange={event => setName(event.target.value)} /></Field>
          <div><Button type="submit" variant="primary" disabled={!name.trim()}>Save name</Button></div>
        </form>
      </Modal>
      <Modal open={sessionAction === "delete"} onClose={() => setSessionAction(null)} title="Delete session?">
        <p>Delete “{session.title || "Untitled session"}” and its messages and attachments from this browser?</p>
        <div className="pg-delete-actions">
          <Button onClick={() => setSessionAction(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { setSessionAction(null); void remove(); }}>Delete session</Button>
        </div>
      </Modal>
      <Drawer open={showSettings} onClose={() => setShowSettings(false)} title="Settings" subtitle="Applied to every model on the next send">
        <div className="form">
          <Field label="System prompt" hint="Sent first in every request. Leave empty for none.">
            <textarea
              rows={5}
              value={settings.system}
              placeholder="You are a concise assistant."
              onChange={(e) => setSettings({ ...settings, system: e.target.value })}
            />
          </Field>
          <Field label={`Temperature: ${settings.temperature.toFixed(1)}`} hint="0 repeats the most likely answer. Higher values vary more.">
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={settings.temperature}
              onChange={(e) => setSettings({ ...settings, temperature: Number(e.target.value) })}
            />
          </Field>
          <Field label="Max output tokens" hint="Reasoning tokens count toward this limit.">
            <input
              type="number"
              min={16}
              max={32000}
              step={64}
              value={settings.maxTokens}
              onChange={(e) => setSettings({ ...settings, maxTokens: Math.max(16, Math.min(32000, Number(e.target.value) || 16)) })}
            />
          </Field>
          <div className="field">
            <span className="field-label">Reasoning</span>
            <Segmented
              label="Reasoning"
              value={settings.reasoning}
              onChange={(reasoning) => setSettings({ ...settings, reasoning })}
              options={[
                { value: "default", label: "Model default" },
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
            />
            <span className="field-hint">
              On and Off set <code>enable_thinking</code> in the chat template. Some models think by default, and a few
              ignore the switch. <DocLink href={docs.reasoning}>Akamai’s reasoning guide</DocLink>
            </span>
          </div>
          <Button variant="ghost" onClick={() => setSettings(DEFAULTS)}>
            Reset to defaults
          </Button>
        </div>
      </Drawer>

      <Modal
        open={showCode}
        onClose={() => setShowCode(false)}
        wide
        title="This request as code"
        footer={<>
          <DocLink href={docs.streaming}>Streaming API guide</DocLink>
          <CopyButton text={code} label="Copy code" />
        </>}
      >
        <div className="code-head">
          <Segmented
            label="Language"
            value={language}
            onChange={setLanguage}
            options={[
              { value: "python", label: "Python" },
              { value: "curl", label: "curl" },
              { value: "node", label: "Node.js" },
            ]}
          />
          {selectedLane && <label className="code-model muted small">
            {savedRequest ? "Last request for" : "Example request for"}
            <select aria-label="Model for code example" value={selectedLane.key} onChange={e => setSelectedKey(Number(e.target.value))}>
              {lanes.map(lane => <option key={lane.key} value={lane.key}>{lane.model}</option>)}
            </select>
          </label>}
        </div>
        <pre className="code-block">
          <code>{code}</code>
        </pre>
      </Modal>
    </div>
  );
}
