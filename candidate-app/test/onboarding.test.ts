import { describe, expect, it } from 'vitest';
import { onboardingRoute } from '../src/lib/onboarding';

const token = 'Yq3xk5J0bO3m0d3vQ1c2hG8fX7nA9sLp4tR6uW2eZ1k';

describe('onboarding links', () => {
  it('recognises the links in onboarding emails', () => {
    expect(onboardingRoute(`/invitation/${token}`)).toEqual({ kind: 'invitation', token });
    expect(onboardingRoute(`/verify-email/${token}`)).toEqual({ kind: 'verify-email', token });
    expect(onboardingRoute('/register/wits-uni')).toEqual({ kind: 'register', organisation: 'wits-uni' });
    expect(onboardingRoute('/register')).toEqual({ kind: 'register', organisation: null });
  });

  it('ignores anything else', () => {
    expect(onboardingRoute('/')).toBeNull();
    expect(onboardingRoute('/invitation/short')).toBeNull();
    expect(onboardingRoute(`/invitation/${token}/extra`)).toBeNull();
    expect(onboardingRoute('/invitation/<script>alert(1)</script>xxxxxxxxxxxx')).toBeNull();
    expect(onboardingRoute('/register/Not_A_Slug')).toEqual({ kind: 'register', organisation: null });
  });
});
