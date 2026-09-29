// Automatic marking (spec section 6, "Results"). Only question types with a
// definite correct option are marked here; free text stays for a human marker.

export interface KeyEntry {
  points: number;
  correctOptionIds: string[];
}

export type AnswerKey = Record<string, KeyEntry>;

export interface StoredAnswer {
  optionId?: string;
  optionIds?: string[];
  text?: string;
}

const AUTO_MARKED = new Set(['mcq', 'true_false', 'multiple_response']);

export interface MarkResult {
  score: number;
  maxScore: number;
  /** Questions that still need a human marker. */
  needsManual: number;
  status: 'marked' | 'pending';
}

export function markAttempt(
  questions: readonly { id: string; type: string }[],
  key: AnswerKey,
  answers: ReadonlyMap<string, StoredAnswer>,
): MarkResult {
  let score = 0;
  let maxScore = 0;
  let needsManual = 0;

  for (const q of questions) {
    const entry = key[q.id];
    if (!entry) continue;
    maxScore += entry.points;
    if (!AUTO_MARKED.has(q.type)) {
      needsManual += 1;
      continue;
    }
    const answer = answers.get(q.id);
    if (!answer) continue;

    const correct = new Set(entry.correctOptionIds);
    if (q.type === 'multiple_response') {
      // All or nothing: partial credit would need a policy decision from the organisation.
      const given = new Set(answer.optionIds ?? []);
      if (given.size === correct.size && [...given].every((id) => correct.has(id))) score += entry.points;
    } else if (answer.optionId !== undefined && correct.has(answer.optionId)) {
      score += entry.points;
    }
  }

  return { score, maxScore, needsManual, status: needsManual > 0 ? 'pending' : 'marked' };
}
