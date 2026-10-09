import { describe, expect, it } from 'vitest';
import { examFromSearch, launchLink } from '../src/lib/launch';

const ID = '3f0a7d2e-9b41-4c55-8a6e-1d2c3b4a5f60';

describe('launch links', () => {
  it('builds a link that names only the exam', () => {
    expect(launchLink(ID)).toBe(`examguard://open?exam=${ID}`);
  });

  it('reads the exam from the address', () => {
    expect(examFromSearch(`?exam=${ID}`)).toBe(ID);
    expect(examFromSearch(`?x=1&exam=${ID.toUpperCase()}`)).toBe(ID.toUpperCase());
  });

  it('ignores anything that is not a real exam id', () => {
    for (const search of ['', '?exam=', '?exam=1', '?exam=../../etc/passwd', `?exam=${ID}x`, '?exam=<script>', '?other=1']) {
      expect(examFromSearch(search), search).toBeNull();
    }
  });
});
