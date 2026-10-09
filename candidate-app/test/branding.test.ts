import { describe, expect, it } from 'vitest';
import { textOn } from '../src/screens/Login';

describe('brand colour', () => {
  it('picks the more readable text colour', () => {
    expect(textOn('#0a6e4f')).toBe('#ffffff');
    expect(textOn('#ffd400')).toBe('#000000');
    expect(textOn('#1f5fbf')).toBe('#ffffff');
  });
});
