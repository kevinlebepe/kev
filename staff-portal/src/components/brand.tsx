import { useEffect, useState } from 'react';
import { API_BASE, request } from '../lib/api';

interface Branding {
  slug: string;
  name: string;
  colour: string | null;
  logo: boolean;
}

/** Fired after the branding is saved, so the sidebar and colours follow at once. */
export const BRANDING_CHANGED = 'examguard:branding-changed';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * Applies the organisation's colour to buttons, links and highlights. A pale
 * colour still fills buttons, but links and text fall back to a dark shade so
 * they stay readable on white.
 */
export function applyBrandColour(colour: string | null) {
  const root = document.documentElement.style;
  if (!colour) {
    for (const v of ['--accent', '--accent-text', '--accent-ink', '--accent-soft']) root.removeProperty(v);
    return;
  }
  const l = luminance(colour);
  root.setProperty('--accent', colour);
  root.setProperty('--accent-text', (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#000000' : '#ffffff');
  // 4.5:1 against white is the WCAG level for normal text.
  root.setProperty('--accent-ink', 1.05 / (l + 0.05) >= 4.5 ? colour : '#1b1f24');
  root.setProperty('--accent-soft', `color-mix(in srgb, ${colour} 10%, white)`);
}

/** The organisation's logo and name at the top of the menu. */
export function OrgBrand() {
  const [brand, setBrand] = useState<Branding | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const load = () =>
      request<Branding>('GET', '/me/branding')
        .then((b) => {
          setBrand(b);
          setVersion((v) => v + 1);
          applyBrandColour(b.colour);
        })
        .catch(() => undefined);
    void load();
    window.addEventListener(BRANDING_CHANGED, load);
    return () => window.removeEventListener(BRANDING_CHANGED, load);
  }, []);

  return (
    <a className="org" href="#/">
      {brand?.logo && <img src={`${API_BASE}/public/organisations/${brand.slug}/logo?v=${version}`} alt="" />}
      <span className="org-name">{brand?.name ?? 'ExamGuard'}</span>
      <span className="org-sub">Staff portal</span>
    </a>
  );
}
