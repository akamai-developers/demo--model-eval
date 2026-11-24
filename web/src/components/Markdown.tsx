import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "../lib/format";

// Model output is untrusted. react-markdown drops raw HTML by default and blocks
// javascript: links. Do not add a raw-HTML plugin or a custom URL transform.

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // No remote fetches from this page: show an image reference as text.
  img: ({ alt }) => <span className="md-image">image: {alt || "untitled"}</span>,
  table: ({ node: _node, ...props }) => (
    <div className="md-table">
      <table {...props} />
    </div>
  ),
};

/** A rendered reply. While it streams, a caret follows the last block. */
export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={cx("md", streaming && "is-streaming")}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
