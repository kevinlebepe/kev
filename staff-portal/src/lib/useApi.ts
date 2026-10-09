import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './api';

/**
 * Loads a GET endpoint and reloads it on demand, or every `refreshMs` for
 * live screens. A failed refresh keeps the last good data on screen.
 */
export function useApi<T>(path: string | null, refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const current = useRef(path);
  current.current = path;

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const result = await request<T>('GET', path);
      if (current.current === path) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (current.current === path) setError((err as Error).message);
    } finally {
      if (current.current === path) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    void reload();
    if (!refreshMs) return;
    const id = setInterval(() => void reload(), refreshMs);
    return () => clearInterval(id);
  }, [reload, refreshMs]);

  return { data, error, loading, reload };
}
