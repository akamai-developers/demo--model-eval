import { ArrowRight, ArrowUpRight, Braces, Columns3, Globe, ListChecks, Search } from "lucide-react";
import { useState } from "react";
import { Button, CopyButton, Modal, Spinner } from "../components/ui";
import { DocLink } from "../components/DocLink";
import { Wave } from "../components/Wave";
import type { Model } from "../lib/api";
import { docs, modelDocs } from "../lib/docs";
import { compact, num } from "../lib/format";
import { maker, ModelMark, useModels } from "../lib/models";
import { Link } from "../lib/router";

const TOOLS = [
  { to: "/playground", Icon: Columns3, name: "Playground", detail: "Compare replies side by side" },
  { to: "/evals", Icon: ListChecks, name: "Evals", detail: "Score models on graded tasks" },
  { to: "/websites", Icon: Globe, name: "Websites", detail: "Build and review the same page" },
];

export function Home({ models }: { models: Model[] }) {
  const { chat, baseUrl, loading, error } = useModels();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [exampleModel, setExampleModel] = useState<Model | null>(null);
  const largest = Math.max(0, ...chat.map((model) => model.max_output_tokens ?? 0));
  const search = query.trim().toLowerCase();
  const visible = models.filter((model) =>
    (kind === "all" || model.kind === kind) &&
    (model.id.toLowerCase().includes(search) || maker(model.id).toLowerCase().includes(search)),
  );
  const metrics = [
    { label: "Chat models", value: chat.length },
    { label: "Embedding models", value: models.length - chat.length },
    ...(largest > 0 ? [{ label: "Max output tokens", value: compact(largest) }] : []),
  ];
  const filters = [
    { value: "all", label: "All", count: models.length },
    { value: "chat", label: "Chat", count: chat.length },
    { value: "embedding", label: "Embeddings", count: models.length - chat.length },
  ];
  const modelId = JSON.stringify(exampleModel?.id);
  const operation = exampleModel?.kind === "embedding"
    ? `result = client.embeddings.create(
    model=${modelId},
    input="Find documents about cloud storage.",
)
print(len(result.data[0].embedding))`
    : `reply = client.chat.completions.create(
    model=${modelId},
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content)`;
  const snippet = `import os
from openai import OpenAI

client = OpenAI(
    base_url=${JSON.stringify(baseUrl || "https://api.akamai-inference.com/v1")},
    api_key=os.getenv("AKAMAI_API_KEY") or os.environ["AKAMAI_INFERENCE_API_KEY"],
)
${operation}`;

  return (
    <div className="home">
      <section className="overview" aria-labelledby="overview-title">
        <div className="hero">
          <Wave />
          <div className="hero-copy">
            <h1 id="overview-title">Model evaluation</h1>
            <p>Explore the models on your Akamai Inference endpoint and compare how they perform on your prompts.</p>
            <dl className="hero-stats">
              {metrics.map(({ label, value }) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{loading && !models.length ? <Spinner /> : error && !models.length ? "–" : value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <nav className="tool-links" aria-label="Evaluation tools">
          {TOOLS.map(({ to, Icon, name, detail }) => (
            <Link key={to} to={to}>
              <span className="tool-icon"><Icon size={20} aria-hidden="true" /></span>
              <span><strong>{name}</strong><small>{detail}</small></span>
              <ArrowRight className="tool-arrow" size={16} aria-hidden="true" />
            </Link>
          ))}
        </nav>
      </section>

      <section className="catalog" aria-labelledby="catalog-title">
        <header className="catalog-head">
          <h2 id="catalog-title">Model catalog</h2>
          <Button icon={<Braces size={16} />} disabled={!visible.length} onClick={() => setExampleModel(visible[0])}>API example</Button>
        </header>
        <p className="catalog-guide">
          Chat completions generate replies. Embeddings turn text into vectors for search.
          {" "}For image input, reasoning and tool support by model, see the{" "}
          <DocLink href={docs.modelLibrary}>Akamai Model Library guide</DocLink>.
        </p>
        <div className="catalog-panel">
          <div className="catalog-tools">
            <label className="catalog-search">
              <Search size={16} aria-hidden="true" />
              <input aria-label="Search models" type="search" placeholder="Search models or makers" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="segmented segmented-sm" role="group" aria-label="Filter by API operation">
              {filters.map((filter) => (
                <button type="button" key={filter.value} className={kind === filter.value ? "segment is-on" : "segment"}
                  aria-pressed={kind === filter.value} onClick={() => setKind(filter.value)}>
                  {filter.label} {filter.count}
                </button>
              ))}
            </div>
            <span className="catalog-count" role="status">{visible.length} of {models.length}</span>
          </div>
          {visible.length > 0 ? (
            <table className="catalog-table">
              <thead>
                <tr><th scope="col">Model</th><th scope="col">API operation</th>{largest > 0 && <th scope="col">Max output tokens</th>}<th scope="col"><span className="sr-only">Action</span></th></tr>
              </thead>
              <tbody>
                {visible.map((model) => {
                  const company = maker(model.id);
                  const publisherDoc = modelDocs.get(model.id);
                  return (
                    <tr key={model.id}>
                      <th scope="row">
                        <div className="catalog-name">
                          <ModelMark id={model.id} size={32} />
                          <div>
                            <strong>{model.id}</strong>
                            <div className="catalog-meta">
                              {company !== model.id && <small>{company}</small>}
                              {publisherDoc && <DocLink href={publisherDoc}>
                                Model docs<span className="sr-only"> for {model.id}</span>
                              </DocLink>}
                            </div>
                          </div>
                        </div>
                      </th>
                      <td><span className={`model-type type-${model.kind}`}>{model.kind === "chat" ? "Chat completions" : "Embeddings"}</span></td>
                      {largest > 0 && <td className="catalog-limit">{num(model.max_output_tokens)}{model.max_output_tokens != null && <span className="tokens-unit"> tokens</span>}</td>}
                      <td className="catalog-action">{model.kind === "chat" ? (
                        <Link to={`/playground?model=${encodeURIComponent(model.id)}`} aria-label={`Try ${model.id} in Playground`}>
                          <span>Try model</span><ArrowUpRight size={16} aria-hidden="true" />
                        </Link>
                      ) : (
                        <button type="button" aria-label={`View embeddings API example for ${model.id}`} onClick={() => setExampleModel(model)}>
                          <span>View example</span><Braces size={16} aria-hidden="true" />
                        </button>
                      )}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="catalog-empty">
              {loading ? <><Spinner /> Reading the model catalog…</> : models.length ? (
                <>No matching models. <button type="button" onClick={() => { setQuery(""); setKind("all"); }}>Clear filters</button></>
              ) : error ? "Connect to the endpoint to load its catalog." : "The endpoint returned an empty catalog."}
            </p>
          )}
        </div>
      </section>

      <Modal open={!!exampleModel} onClose={() => setExampleModel(null)} title={exampleModel?.kind === "embedding" ? "Create embeddings with Python" : "Send a chat message with Python"} wide footer={<CopyButton text={snippet} label="Copy code" />}>
        <pre className="code-block"><code>{snippet}</code></pre>
        {exampleModel?.kind === "embedding"
          ? <DocLink href={docs.embeddings}>Embeddings API guide</DocLink>
          : <DocLink href={docs.api}>Chat completions API guide</DocLink>}
      </Modal>
    </div>
  );
}
