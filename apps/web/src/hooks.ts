import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export function useLoad<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    if (!url) return;
    try {
      setData(await api.get<T>(url));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [url]);
  useEffect(() => void reload(), [reload]);
  return { data, error, reload };
}
