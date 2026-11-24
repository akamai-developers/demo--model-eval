import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/format";

export function DocLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return <a className={cx("doc-link", className)} href={href} target="_blank" rel="noopener noreferrer">
    {children}<ArrowUpRight size={13} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span>
  </a>;
}
