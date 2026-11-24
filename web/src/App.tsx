import { BookOpen, Columns3, Globe, Layers3, ListChecks, Moon, RefreshCw, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Callout } from "./components/ui";
import { DocLink } from "./components/DocLink";
import { docs } from "./lib/docs";
import { cx } from "./lib/format";
import { useModels } from "./lib/models";
import { Link, useLocation } from "./lib/router";
import { Evals } from "./pages/Evals";
import { Docs } from "./pages/Docs";
import { Home } from "./pages/Home";
import { Playground } from "./pages/Playground";
import { Websites } from "./pages/Websites";

const PAGES = [
  { path: "/", label: "Models", Icon: Layers3 },
  { path: "/playground", label: "Playground", Icon: Columns3 },
  { path: "/evals", label: "Evals", Icon: ListChecks },
  { path: "/websites", label: "Websites", Icon: Globe },
  { path: "/docs", label: "Docs", Icon: BookOpen },
];

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* storage blocked: the toggle still works for this visit */
    }
  }, [theme]);
  return [theme, () => setTheme(theme === "dark" ? "light" : "dark")] as const;
}

export function App() {
  const { path, search } = useLocation();
  const active = PAGES.some((p) => p.path === path) ? path : "/";
  const [visited, setVisited] = useState<string[]>([active]);
  const [theme, toggleTheme] = useTheme();
  const { chat, models, baseUrl, loading, error, refresh } = useModels();

  useEffect(() => {
    setVisited((v) => (v.includes(active) ? v : [...v, active]));
    document.title = `${PAGES.find((p) => p.path === active)?.label} · Akamai Inference`;
  }, [active]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [active]);

  const host = baseUrl.replace(/^https?:\/\//, "").replace(/\/v1$/, "");

  return (
    <div className="app">
      <header className="nav">
        <Link to="/" className="nav-brand" aria-label="Akamai Inference model eval, home">
          <img src={theme === "dark" ? "/brand/akamai-logo-white.svg" : "/brand/akamai-logo.svg"} alt="Akamai" height={30} />
          <span className="nav-product">Model Eval</span>
        </Link>
        <nav className="nav-tabs" aria-label="Screens">
          {PAGES.map((page) => (
            <Link
              key={page.path}
              to={page.path}
              className={cx("nav-tab", active === page.path && "is-on")}
              aria-current={active === page.path ? "page" : undefined}
            >
              <page.Icon size={16} aria-hidden="true" />{page.label}
            </Link>
          ))}
        </nav>
        <div className="nav-end">
          <button
            type="button"
            className={cx("nav-status", error && "is-down")}
            onClick={refresh}
            disabled={loading}
            title={`Refresh the model list${host ? ` from ${host}` : ""}`}
          >
            <span className="nav-dot" aria-hidden="true" />
            {loading ? "Connecting" : error ? "Not connected" : `${chat.length} chat models`}
            <RefreshCw size={13} className={cx(loading && "spin")} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="nav-icon"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      {error && (
        <div className="page-alert">
          <Callout tone="red" title="The app cannot reach Akamai Inference">
            {error} Then restart the server with <code>make start</code>.{" "}
            <DocLink href={docs.keys}>API key setup</DocLink>
          </Callout>
        </div>
      )}

      <main className="main">
        {active === "/docs" && <Docs />}
        {visited.includes("/") && (
          <div hidden={active !== "/"} className="page-slot">
            <Home models={models} />
          </div>
        )}
        {visited.includes("/playground") && (
          <div hidden={active !== "/playground"} className="page-slot">
            <Playground search={active === "/playground" ? search : ""} />
          </div>
        )}
        {visited.includes("/evals") && (
          <div hidden={active !== "/evals"} className="page-slot">
            <Evals search={active === "/evals" ? search : ""} />
          </div>
        )}
        {visited.includes("/websites") && (
          <div hidden={active !== "/websites"} className="page-slot">
            <Websites />
          </div>
        )}
      </main>
    </div>
  );
}
