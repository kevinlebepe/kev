import { useEffect, useState } from 'react';
import { download, fetchBlob } from '../lib/api';

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

/** One recorded piece: played on demand. Each play is recorded in the audit log; saving a copy needs its own permission. */
export function Chunk({ id, contentType, label, canDownload = false }: { id: string; contentType: string; label: string; canDownload?: boolean }) {
  const [open, setOpen] = useState(false);
  const { url, state } = useBlobUrl(open ? `/recording-chunks/${id}` : null);
  const save = canDownload ? (
    <button className="small link" onClick={() => void download(`/recording-chunks/${id}?download=1`, `recording-${label}`)} aria-label={`Download ${label}`}>
      Download
    </button>
  ) : null;
  if (!open) {
    return (
      <span className="row">
        <button className="small" onClick={() => setOpen(true)}>
          {label}
        </button>
        {save}
      </span>
    );
  }
  if (state === 'error' || state === 'none') return <span className="error small">Could not load {label}</span>;
  if (!url) return <span className="muted small">Loading {label}…</span>;
  const player = contentType.startsWith('image/') ? (
    <img className="frame" src={url} alt={label} />
  ) : contentType.startsWith('audio/') ? (
    <audio controls src={url} aria-label={label} />
  ) : (
    <video className="clip" controls src={url} aria-label={label} />
  );
  return (
    <span className="stack">
      {player}
      {save}
    </span>
  );
}
