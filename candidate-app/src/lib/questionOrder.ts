/**
 * The questions this candidate sees, in order. When the server names them
 * (the exam shuffles, or draws from question pools) only those are shown;
 * otherwise every question in the published order.
 */
export function orderedQuestions<Q extends { id: string }>(questions: readonly Q[], order?: readonly string[] | null): Q[] {
  if (!order?.length) return [...questions];
  const byId = new Map(questions.map((q) => [q.id, q]));
  return order.map((id) => byId.get(id)).filter((q): q is Q => q !== undefined);
}
