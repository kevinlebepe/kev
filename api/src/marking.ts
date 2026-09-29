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
  fileId?: string;
}

export type PartialCredit = 'none' | 'proportional';

/** A free text or file answer that a marker needs to look at. */
const hasContent = (a: StoredAnswer | undefined) => Boolean(a?.text?.trim() || a?.fileId);

export const AUTO_MARKED = new Set(['mcq', 'true_false', 'multiple_response']);

export interface QuestionMark {
  questionId: string;
  maxPoints: number;
  /** Null while a free text answer waits for a human marker. */
  awarded: number | null;
  auto: boolean;
}

export interface MarkResult {
  score: number;
  maxScore: number;
  /** Questions that still need a human marker. */
  needsManual: number;
  status: 'marked' | 'pending';
  questions: QuestionMark[];
}

function autoMark(type: string, entry: KeyEntry, answer: StoredAnswer | undefined, partialCredit: PartialCredit): number {
  if (!answer) return 0;
  const correct = new Set(entry.correctOptionIds);
  if (type === 'multiple_response') {
    const given = new Set(answer.optionIds ?? []);
    if (partialCredit === 'proportional' && correct.size) {
      const right = [...given].filter((id) => correct.has(id)).length;
      const wrong = given.size - right;
      return Math.round(Math.max(0, (right - wrong) / correct.size) * entry.points * 100) / 100;
    }
    return given.size === correct.size && [...given].every((id) => correct.has(id)) ? entry.points : 0;
  }
  return answer.optionId !== undefined && correct.has(answer.optionId) ? entry.points : 0;
}

/**
 * Marks an attempt. Choice questions are marked from the answer key. Free
 * text takes the human mark when there is one. An unanswered free text
 * question needs no marker: it scores nothing.
 */
export function markAttempt(
  questions: readonly { id: string; type: string }[],
  key: AnswerKey,
  answers: ReadonlyMap<string, StoredAnswer>,
  manual: ReadonlyMap<string, number> = new Map(),
  partialCredit: PartialCredit = 'none',
): MarkResult {
  let score = 0;
  let maxScore = 0;
  let needsManual = 0;
  const marks: QuestionMark[] = [];

  for (const q of questions) {
    const entry = key[q.id];
    if (!entry) continue;
    maxScore += entry.points;
    const auto = AUTO_MARKED.has(q.type);
    let awarded: number | null;
    if (auto) awarded = autoMark(q.type, entry, answers.get(q.id), partialCredit);
    else if (manual.has(q.id)) awarded = Math.min(manual.get(q.id)!, entry.points);
    else if (!hasContent(answers.get(q.id))) awarded = 0;
    else awarded = null;

    if (awarded === null) needsManual += 1;
    else score += awarded;
    marks.push({ questionId: q.id, maxPoints: entry.points, awarded, auto });
  }

  return { score, maxScore, needsManual, status: needsManual > 0 ? 'pending' : 'marked', questions: marks };
}
