import { useEffect, useState } from 'react';
import { fetchBlob } from '../lib/api';

/**
 * Loads a protected file into an object URL. Recordings need the signed in
 * user's credentials, so a plain src attribute cannot fetch them.
 */
export function useBlobUrl(path: string | null, refreshKey: unknown = null) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'none' | 'error' | 'ready'>('idle');
  useEffect(() => {
    if (!path) return;
    let revoked = false;
    let created: string | null = null;
    setState((s) => (s === 'ready' ? s : 'loading'));
    fetchBlob(path)
      .then((blob) => {
        if (revoked) return;
        if (!blob) return setState('none');
        created = URL.createObjectURL(blob);
        setUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return created;
        });
        setState('ready');
      })
      .catch(() => !revoked && setState('error'));
    return () => {
      revoked = true;
    };
  }, [path, refreshKey]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return { url, state };
}

export function Snapshot({ attemptId, at }: { attemptId: string; at: string | null }) {
  const { url, state } = useBlobUrl(at ? `/live/attempts/${attemptId}/snapshot` : null, at);
  if (!at || state === 'none') return <p className="muted small">No camera picture yet.</p>;
  if (!url) return <p className="muted small">Loading camera picture…</p>;
  return <img className="snapshot" src={url} alt="Latest camera picture of the candidate" />;
}

export function Chunk({ id, contentType, label }: { id: string; contentType: string; label: string }) {
  const [open, setOpen] = useState(false);
  const { url, state } = useBlobUrl(open ? `/recording-chunks/${id}` : null);
  if (!open) {
    return (
      <button className="small" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  if (state === 'error' || state === 'none') return <span className="error small">Could not load {label}</span>;
  if (!url) return <span className="muted small">Loading {label}…</span>;
  if (contentType.startsWith('image/')) return <img className="frame" src={url} alt={label} />;
  if (contentType.startsWith('audio/')) return <audio controls src={url} aria-label={label} />;
  return <video className="clip" controls src={url} aria-label={label} />;
}
