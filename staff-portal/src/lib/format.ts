const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : '');
export const formatTime = (iso: string | null | undefined) => (iso ? time.format(new Date(iso)) : '');

/** 1:05:09 or 5:09. Negative values show as 0:00. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Turns snake_case keys into readable words: pending_approval → Pending approval. */
export function label(value: string | null | undefined): string {
  if (!value) return '';
  const words = value.replaceAll('_', ' ');
  return words[0]!.toUpperCase() + words.slice(1);
}

/** Converts a datetime-local input value to an ISO string with the browser's offset. */
export function localToIso(local: string): string {
  return new Date(local).toISOString();
}

/** The value a datetime-local input expects for a moment in time. */
export function isoToLocal(iso: string | Date): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Reads candidates from pasted CSV text: email, full name, student id, programme. */
export function parseCandidateCsv(text: string): { email: string; fullName: string; studentId?: string; programme?: string }[] {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(splitCsvLine);
  if (rows[0] && /e-?mail/i.test(rows[0][0] ?? '')) rows.shift();
  return rows
    .filter((r) => r[0] && r[1])
    .map(([email, fullName, studentId, programme]) => ({
      email: email!.trim(),
      fullName: fullName!.trim(),
      ...(studentId?.trim() ? { studentId: studentId.trim() } : {}),
      ...(programme?.trim() ? { programme: programme.trim() } : {}),
    }));
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** An invigilator with the live console open checks in every few seconds. */
export function connected(lastSeenAt: string | null | undefined, now = Date.now()): boolean {
  return Boolean(lastSeenAt && now - Date.parse(lastSeenAt) < 120_000);
}
