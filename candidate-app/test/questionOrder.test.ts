import { describe, expect, it } from 'vitest';
import { orderedQuestions } from '../src/lib/questionOrder';

const qs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('question order', () => {
  it('follows the order the server chose', () => {
    expect(orderedQuestions(qs, ['c', 'a', 'b']).map((q) => q.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps the published order when there is none', () => {
    expect(orderedQuestions(qs, null).map((q) => q.id)).toEqual(['a', 'b', 'c']);
  });

  it('shows only the questions drawn for this candidate, ignoring unknown ids', () => {
    expect(orderedQuestions(qs, ['b', 'x']).map((q) => q.id)).toEqual(['b']);
  });
});
