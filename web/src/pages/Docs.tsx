import { DocLink } from "../components/DocLink";
import { docs } from "../lib/docs";
import { Link } from "../lib/router";

const sections = [
  {
    title: "Akamai Inference",
    links: [
      ["Inference dashboard", docs.dashboard],
      ["Manage inference API keys", docs.keys],
      ["Compare model capabilities in the Model Library", docs.modelLibrary],
      ["Use the Cloud Manager Playground", docs.playground],
      ["Chat completions, streaming and embeddings", docs.api],
      ["Set reasoning effort", docs.reasoning],
      ["Monitor token usage", docs.usage],
      ["Troubleshoot inference errors", docs.errors],
    ],
  },
  {
    title: "Tool selection evals",
    links: [
      ["Claude Code tool reference", docs.claudeTools],
      ["Pi coding agent tools", docs.piTools],
      ["Akamai Cloud API operations", docs.cloudApi],
    ],
  },
];

export function Docs() {
  return (
    <div className="docs-page">
      <h1>Documentation</h1>
      <p className="docs-intro">In the <Link to="/">model catalog</Link>, choose <strong>Model docs</strong> beneath a model name to read its publisher’s reference.</p>
      <div className="docs-sections">
        {sections.map(({ title, links }) => (
          <section key={title}>
            <h2>{title}</h2>
            <ul>{links.map(([label, href]) => <li key={href}><DocLink href={href}>{label}</DocLink></li>)}</ul>
          </section>
        ))}
      </div>
    </div>
  );
}
