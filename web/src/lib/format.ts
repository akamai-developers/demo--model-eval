export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

const whole = new Intl.NumberFormat("en-US");

export const num = (value: number | null | undefined) => (value == null ? "–" : whole.format(Math.round(value)));

/** 420 ms, 1.8 s, 2 min 5 s */
export function duration(ms: number | null | undefined): string {
  if (ms == null) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

export const percent = (value: number | null | undefined) => (value == null ? "–" : `${Math.round(value * 100)}%`);

export function bytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
}

/** 131072 -> 131K, 1048576 -> 1M */
export function compact(value: number | null | undefined): string {
  if (value == null) return "–";
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

export function ago(epochSeconds: number): string {
  const minutes = Math.round((Date.now() / 1000 - epochSeconds) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Read a value from localStorage, falling back when storage is blocked or the value is malformed. */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window or full storage: the page works without it */
  }
}
