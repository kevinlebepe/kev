// Links in onboarding emails open the app at these addresses.

export type OnboardingRoute =
  | { kind: 'invitation'; token: string }
  | { kind: 'verify-email'; token: string }
  | { kind: 'register'; organisation: string | null }
  | { kind: 'reset-password'; token: string }
  | null;

const TOKEN = /^[A-Za-z0-9_-]{16,200}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function onboardingRoute(pathname: string): OnboardingRoute {
  const [first, second, ...rest] = pathname.split('/').filter(Boolean);
  if (rest.length) return null;
  if (first === 'invitation' && second && TOKEN.test(second)) return { kind: 'invitation', token: second };
  if (first === 'verify-email' && second && TOKEN.test(second)) return { kind: 'verify-email', token: second };
  if (first === 'reset-password' && second && TOKEN.test(second)) return { kind: 'reset-password', token: second };
  if (first === 'register') return { kind: 'register', organisation: second && SLUG.test(second) ? second : null };
  return null;
}
