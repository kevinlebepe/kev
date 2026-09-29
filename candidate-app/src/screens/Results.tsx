export interface ReleasedResult {
  entitlementId: string;
  examName: string;
  examCode: string;
  sessionName: string;
  score: number;
  maxScore: number;
  percent: number | null;
  releasedAt: string;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** Results appear here only after the organisation releases them. */
export function Results({ items }: { items: ReleasedResult[] }) {
  if (items.length === 0) return null;
  return (
    <section className="results">
      <h2>My results</h2>
      <ul className="list">
        {items.map((r) => (
          <li key={r.entitlementId} className="card">
            <div className="row spread">
              <div>
                <h3>{r.examName}</h3>
                <p className="muted small">
                  {r.examCode} · {r.sessionName} · released {dateFormat.format(new Date(r.releasedAt))}
                </p>
              </div>
              <p className="score" aria-label={`Score ${r.score} out of ${r.maxScore}`}>
                <strong>{r.score}</strong> / {r.maxScore}
                {r.percent !== null && <span className="muted"> ({r.percent}%)</span>}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
