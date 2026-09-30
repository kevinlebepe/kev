/**
 * The questions in the order this candidate sees them. The server chooses the
 * order when the exam shuffles; anything it does not name keeps its place at the end.
 */
export function orderedQuestions<Q extends { id: string }>(questions: readonly Q[], order?: readonly string[] | null): Q[] {
  if (!order?.length) return [...questions];
  const byId = new Map(questions.map((q) => [q.id, q]));
  const first = order.map((id) => byId.get(id)).filter((q): q is Q => q !== undefined);
  const named = new Set(first.map((q) => q.id));
  return [...first, ...questions.filter((q) => !named.has(q.id))];
}
