import type { ChatBody, Metrics, Reasoning } from "./api";
import type { Attachment } from "./attachments";

export interface Turn {
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  reasoning?: string;
  status?: "streaming" | "done" | "error" | "stopped";
  error?: string;
  metrics?: Metrics;
  model?: string;
}

interface Transcript {
  turns: Turn[];
  lastRequest?: Omit<ChatBody, "messages"> & { turnCount: number };
}

export interface Lane extends Transcript {
  key: number;
  model: string;
  previous?: Record<string, Transcript>;
}

export interface Settings {
  system: string;
  temperature: number;
  maxTokens: number;
  reasoning: Reasoning;
}

export const DEFAULTS: Settings = { system: "", temperature: 0.7, maxTokens: 2048, reasoning: "default" };

export interface Session {
  id: string;
  created: number;
  title: string;
  settings: Settings;
  lanes: Lane[];
  draft: string;
  attachments: Attachment[];
  selectedKey: number | null;
}

export type SessionLabel = Pick<Session, "id" | "created" | "title">;

export function newSession(settings: Settings, models: string[] = []): Session {
  return {
    id: crypto.randomUUID(), created: Date.now(), title: "", settings,
    lanes: models.map((model, i) => ({ key: i + 1, model, turns: [] })),
    draft: "", attachments: [], selectedKey: null,
  };
}

export function changeModel(lane: Lane, model: string): Lane {
  if (model === lane.model) return lane;
  const previous = { ...lane.previous, [lane.model]: { turns: lane.turns, lastRequest: lane.lastRequest } };
  const transcript = Object.hasOwn(previous, model) ? previous[model] : { turns: [] };
  delete previous[model];
  return { key: lane.key, model, previous, ...transcript };
}

export function restoreSession(session: Session): Session {
  if (!session.lanes.some(lane => lane.turns.some(turn => turn.status === "streaming"))) return session;
  return { ...session, lanes: session.lanes.map(lane => ({
    ...lane, turns: lane.turns.map(turn => turn.status === "streaming" ? { ...turn, status: "stopped" } : turn),
  })) };
}

export function openSessions(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("model-eval-playground", 1);
    request.onupgradeneeded = () => {
      const sessions = request.result.createObjectStore("sessions", { keyPath: "id" });
      sessions.createIndex("labels", ["created", "title"]);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function listSessions(db: IDBDatabase): Promise<SessionLabel[]> {
  // Read names through the index so opening the page doesn't load every stored image.
  return new Promise((resolve, reject) => {
    const labels: SessionLabel[] = [];
    const cursor = db.transaction("sessions").objectStore("sessions").index("labels").openKeyCursor(null, "prev");
    cursor.onsuccess = () => {
      if (!cursor.result) return resolve(labels);
      const [created, title] = cursor.result.key as [number, string];
      labels.push({ id: cursor.result.primaryKey as string, created, title });
      cursor.result.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

export function getSession(db: IDBDatabase, id: string): Promise<Session | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction("sessions").objectStore("sessions").get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function writeSession(db: IDBDatabase, session: Session | string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("sessions", "readwrite");
    const store = transaction.objectStore("sessions");
    if (typeof session === "string") store.delete(session);
    else store.put(session);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}
