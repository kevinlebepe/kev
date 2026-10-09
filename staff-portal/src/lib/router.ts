import { useEffect, useState } from 'react';

// Hash based routing: #/sessions/abc becomes ['sessions', 'abc']. No server
// configuration is needed to serve the portal from any static host.

export function parseHash(hash: string): string[] {
  return hash
    .replace(/^#\/?/, '')
    .split('?')[0]!
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
}

export function useRoute(): string[] {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const href = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join('/')}`;

export function navigate(...parts: string[]) {
  window.location.hash = href(...parts);
}
