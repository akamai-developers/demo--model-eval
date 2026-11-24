import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Model } from "./api";

interface Catalog {
  models: Model[];
  chat: Model[];
  baseUrl: string;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const Context = createContext<Catalog | null>(null);

/** Loads the model list from the endpoint once and shares it with every page. */
export function ModelsProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<Model[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = useCallback((refresh: boolean) => {
    setLoading(true);
    api<{ base_url: string; models: Model[] }>(`/models${refresh ? "?refresh=true" : ""}`)
      .then((data) => {
        setModels(data.models);
        setBaseUrl(data.base_url);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => fetchModels(false), [fetchModels]);

  const value = useMemo(
    () => ({
      models,
      chat: models.filter((m) => m.kind === "chat"),
      baseUrl,
      loading,
      error,
      refresh: () => fetchModels(true),
    }),
    [models, baseUrl, loading, error, fetchModels],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useModels(): Catalog {
  const value = useContext(Context);
  if (!value) throw new Error("useModels needs ModelsProvider");
  return value;
}

// /v1/models returns ids only. The maker is read from the id so the list is
// easier to scan. An id this table does not know still shows up, under its own name.
const MAKERS: [RegExp, string][] = [
  [/^qwen/, "Qwen"],
  [/^gemma/, "Google"],
  [/^deepseek/, "DeepSeek"],
  [/^glm/, "Z.ai"],
  [/^gpt-oss/, "OpenAI"],
  [/^kimi/, "Moonshot AI"],
  [/^(nvidia|nemotron)/, "NVIDIA"],
  [/^(llama|meta)/, "Meta"],
  [/^(mistral|mixtral|codestral)/, "Mistral"],
  [/^phi/, "Microsoft"],
];

export function maker(id: string): string {
  const found = MAKERS.find(([pattern]) => pattern.test(id.toLowerCase()));
  return found ? found[1] : id.split(/[-/]/)[0];
}

export function ModelMark({ id, size = 28 }: { id: string; size?: number }) {
  const name = maker(id);
  return (
    <span className="model-mark" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
