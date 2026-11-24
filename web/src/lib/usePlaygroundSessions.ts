import { useCallback, useEffect, useRef, useState } from "react";
import { load, save } from "./format";
import { DEFAULTS, getSession, listSessions, newSession, openSessions, restoreSession, writeSession, type Session, type SessionLabel } from "./playgroundSessions";

const ACTIVE_KEY = "playground.active-session";

function initialSession() {
  return newSession({ ...DEFAULTS, ...load("playground.settings", {}) });
}

export function usePlaygroundSessions() {
  const [session, setSession] = useState(initialSession);
  const [labels, setLabels] = useState<SessionLabel[]>([]);
  const [ready, setReady] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [storageError, setStorageError] = useState("");
  const db = useRef<IDBDatabase | null>(null);
  const unsaved = useRef(new Map<string, Session>());
  const lastSnapshot = useRef<Session | null>(null);
  const checkpoint = useRef({ since: 0, streaming: false });
  const current = useRef(session);
  current.current = session;

  useEffect(() => {
    let cancelled = false;
    let connection: IDBDatabase | undefined;
    async function open() {
      try {
        connection = await openSessions();
        if (cancelled) { connection.close(); return; }
        const saved = await listSessions(connection);
        const lastId = load<string>(ACTIVE_KEY, "");
        const id = saved.find(item => item.id === lastId)?.id ?? saved[0]?.id;
        const last = id ? await getSession(connection, id) : undefined;
        if (cancelled) return;
        db.current = connection;
        setLabels(saved);
        if (last) {
          lastSnapshot.current = restoreSession(last);
          setSession(lastSnapshot.current);
        }
      } catch {
        if (!cancelled) setStorageError("Browser storage is unavailable. Sessions will last until this tab closes.");
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    void open();
    return () => { cancelled = true; connection?.close(); };
  }, []);

  const persist = useCallback((value: Session) => {
    // Opening or closing a tab must never write its unchanged copy over another tab's edits.
    if (lastSnapshot.current === value) return;
    lastSnapshot.current = value;
    unsaved.current.set(value.id, value);
    if (db.current) {
      void writeSession(db.current, value).then(() => {
        if (unsaved.current.get(value.id) === value) unsaved.current.delete(value.id);
      }).catch(() => setStorageError("The browser could not save this session. Your changes are still in this tab."));
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const streaming = session.lanes.some(lane => lane.turns.at(-1)?.status === "streaming");
    if (streaming && checkpoint.current.streaming && Date.now() - checkpoint.current.since < 800) return;
    checkpoint.current = { since: Date.now(), streaming };
    persist(session);
  }, [ready, session, persist]);

  useEffect(() => {
    if (!ready) return;
    const flush = () => persist(current.current);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [ready, persist]);

  const { id, title, created } = session;
  useEffect(() => {
    if (!ready) return;
    save(ACTIVE_KEY, id);
    setLabels(previous => [{ id, title, created }, ...previous.filter(label => label.id !== id)]
      .sort((a, b) => b.created - a.created));
  }, [id, title, created, ready]);

  async function select(id: string) {
    if (switching || id === session.id) return;
    setSwitching(true);
    try {
      const next = unsaved.current.get(id) ?? (db.current && await getSession(db.current, id));
      if (next) {
        lastSnapshot.current = restoreSession(next);
        setSession(lastSnapshot.current);
      }
      else {
        setLabels(current => current.filter(label => label.id !== id));
        setStorageError("This session was removed from browser storage.");
      }
    } catch {
      setStorageError("The browser could not open this session.");
    } finally {
      setSwitching(false);
    }
  }

  function create(models = session.lanes.map(lane => lane.model)) {
    setSession(newSession({ ...session.settings }, models));
  }

  async function remove() {
    if (switching) return;
    setSwitching(true);
    try {
      const remaining = labels.filter(label => label.id !== session.id);
      const nextId = remaining[0]?.id;
      const next = nextId ? unsaved.current.get(nextId) ?? (db.current && await getSession(db.current, nextId)) : undefined;
      if (db.current) await writeSession(db.current, session.id);
      unsaved.current.delete(session.id);
      setLabels(remaining);
      if (next) {
        lastSnapshot.current = restoreSession(next);
        setSession(lastSnapshot.current);
      }
      else create();
    } catch {
      setStorageError("The browser could not delete this session.");
    } finally {
      setSwitching(false);
    }
  }

  return { session, setSession, labels, ready, switching, storageError, select, create, remove };
}
