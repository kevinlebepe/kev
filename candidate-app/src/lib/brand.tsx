import { createContext, useContext, useEffect, useState } from 'react';
import { API_BASE, request } from './api';

/** The candidate's organisation, shown on every screen after sign in, the exam included. */
export interface OrgBrand {
  slug: string;
  name: string;
  colour: string | null;
  logo: boolean;
}

const REMEMBERED = 'examguard.organisation';

/** The organisation code last used on this device, or one named in the address (?org=unisa). */
export function rememberedOrganisation(search = window.location.search): string {
  const fromLink = new URLSearchParams(search).get('org');
  if (fromLink) return fromLink.trim().toLowerCase();
  try {
    return localStorage.getItem(REMEMBERED) ?? '';
  } catch {
    return '';
  }
}

export function rememberOrganisation(slug: string) {
  try {
    localStorage.setItem(REMEMBERED, slug.trim().toLowerCase());
  } catch {
    // Private windows may refuse storage; the code is simply typed again next time.
  }
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Black or white, whichever reads better on a #rrggbb background (WCAG relative luminance). */
export function textOn(hex: string): string {
  const l = luminance(hex);
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
}

/**
 * Makes the organisation's colour the app's accent. A pale colour still fills
 * buttons, but links and text use a dark shade so they stay readable.
 */
export function applyBrandColour(colour: string | null | undefined) {
  const root = document.documentElement.style;
  if (!colour) {
    for (const v of ['--accent', '--accent-text', '--accent-ink', '--accent-soft']) root.removeProperty(v);
    return;
  }
  root.setProperty('--accent', colour);
  root.setProperty('--accent-text', textOn(colour));
  root.setProperty('--accent-ink', 1.05 / (luminance(colour) + 0.05) >= 4.5 ? colour : '#1b1f24');
  root.setProperty('--accent-soft', `color-mix(in srgb, ${colour} 10%, white)`);
}

export const BrandContext = createContext<OrgBrand | null>(null);
export const useBrand = () => useContext(BrandContext);

/** Loads the signed in candidate's branding and applies its colour. */
export function useOrgBrand(signedIn: boolean): OrgBrand | null {
  const [brand, setBrand] = useState<OrgBrand | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    let stale = false;
    request<OrgBrand>('GET', '/me/branding')
      .then((b) => {
        if (stale) return;
        setBrand(b);
        applyBrandColour(b.colour);
        rememberOrganisation(b.slug);
      })
      // Branding is a nicety: the exam works without it.
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [signedIn]);
  return brand;
}

/** The organisation's logo and name, or ExamGuard when there is none. */
export function BrandMark({ brand, compact = false }: { brand: OrgBrand | null; compact?: boolean }) {
  return (
    <span className={`brand-mark ${compact ? 'compact' : ''}`}>
      {brand?.logo && <img src={`${API_BASE}/public/organisations/${brand.slug}/logo`} alt="" />}
      <span className="brand-name">{brand?.name ?? 'ExamGuard'}</span>
    </span>
  );
}
