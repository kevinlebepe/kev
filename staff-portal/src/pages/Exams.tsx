import { useEffect, useState } from 'react';
import { ActionButton, Badge, Check, ErrorText, Field, Form, Loading, Page } from '../components/ui';
import { request } from '../lib/api';
import { formatDateTime, label } from '../lib/format';
import { href, navigate } from '../lib/router';
import { can, useMe } from '../lib/session';
import { useApi } from '../lib/useApi';

interface ExamRow {
  id: string;
  code: string;
  name: string;
  status: string;
  updatedAt: string;
  latestVersion: number | null;
}

interface ExamDetailData {
  id: string;
  code: string;
  name: string;
  description: string;
  status: string;
  config: Config;
  questions: { id: string; type: string; prompt: string; position: number; points: number }[];
  versions: { id: string; version: number; manifestSha256: string; publishedAt: string }[];
}

type Policy = 'flag' | 'warn_then_submit' | 'submit_immediately';
const OS = ['windows', 'macos', 'linux', 'chromeos', 'android', 'ios'] as const;

/** The parts of the exam configuration the portal edits. Anything else is kept as stored. */
export interface Config {
  timing: { durationMinutes?: number; startWindowMinutes: number; lateEntryMinutes: number; autoSubmit: boolean };
  security: {
    kiosk: boolean;
    screenCapture: boolean;
    camera: boolean;
    microphone: boolean;
    eventMonitoring: boolean;
    fullscreen: boolean;
    blockClipboard: boolean;
    violationPolicy: Policy;
    maxViolations: number;
  };
  navigation: { allowBacktrack: boolean; randomiseQuestionOrder: boolean };
  device: {
    supportedOs: string[];
    minFreeStorageMb: number;
    allowExternalMonitors: boolean;
    allowVirtualMachines: boolean;
    requireDesktopApp: boolean;
  };
  [key: string]: unknown;
}

/** Fills in the server's defaults so every control has a value. */
export function withDefaults(raw: Partial<Config> | null | undefined): Config {
  const c = (raw ?? {}) as Partial<Config>;
  return {
    ...c,
    timing: { startWindowMinutes: 15, lateEntryMinutes: 0, autoSubmit: true, ...c.timing },
    security: {
      kiosk: true,
      screenCapture: false,
      camera: false,
      microphone: false,
      eventMonitoring: true,
      fullscreen: true,
      blockClipboard: true,
      violationPolicy: 'flag',
      maxViolations: 3,
      ...c.security,
    },
    navigation: { allowBacktrack: true, randomiseQuestionOrder: false, ...c.navigation },
    device: {
      supportedOs: ['windows', 'macos'],
      minFreeStorageMb: 2048,
      allowExternalMonitors: false,
      allowVirtualMachines: false,
      requireDesktopApp: false,
      ...c.device,
    },
  };
}

export function Exams() {
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const list = useApi<{ items: ExamRow[] }>('/exams?limit=100');
  return (
    <Page title="Exams" actions={<button onClick={() => setCreating(!creating)}>New exam</button>}>
      {creating && <CreateExam onCancel={() => setCreating(false)} />}
      <ErrorText error={list.error} />
      <Loading loading={list.loading} empty={list.data?.items.length === 0 && 'No exams yet. Create one to start.'}>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Status</th>
              <th>Published versions</th>
              <th>Last changed</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((e) => (
              <tr key={e.id}>
                <td>
                  <a href={href('exams', e.id)}>{e.code}</a>
                </td>
                <td>{e.name}</td>
                <td>
                  <Badge value={e.status} />
                </td>
                <td>{e.latestVersion ?? 'None'}</td>
                <td className="muted small">{formatDateTime(e.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Loading>
      {!can(me, 'exam:publish') && <p className="muted small">Your role can prepare exams. Someone with publishing rights must publish them.</p>}
    </Page>
  );
}

function CreateExam({ onCancel }: { onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [duration, setDuration] = useState(60);
  return (
    <Form
      submitText="Create exam"
      onCancel={onCancel}
      onSubmit={async () => {
        const created = await request<{ id: string }>('POST', '/exams', {
          code: code.trim(),
          name: name.trim(),
          config: { timing: { durationMinutes: duration } },
        });
        navigate('exams', created.id);
      }}
    >
      <h2>New exam</h2>
      <div className="grid3">
        <Field label="Code" hint="Letters, numbers, dots, dashes. For example MATH101-2026.">
          <input value={code} onChange={(e) => setCode(e.target.value)} pattern="[A-Za-z0-9._\-]{1,50}" required />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Duration in minutes">
          <input type="number" min={1} max={1440} value={duration} onChange={(e) => setDuration(Number(e.target.value))} required />
        </Field>
      </div>
    </Form>
  );
}

export function ExamDetail({ id }: { id: string }) {
  const me = useMe();
  const exam = useApi<ExamDetailData>(`/exams/${id}`);
  const [publishResult, setPublishResult] = useState<string | null>(null);
  const d = exam.data;

  return (
    <Page
      title={d ? `${d.code} · ${d.name}` : 'Exam'}
      back={{ href: href('exams'), text: 'Exams' }}
      actions={
        d &&
        can(me, 'exam:publish') && (
          <ActionButton
            className="primary"
            confirm="Publish this exam? The published version is fixed and signed. Later edits need a new version."
            onClick={async () => {
              const v = await request<{ version: number }>('POST', `/exams/${id}/publish`);
              setPublishResult(`Version ${v.version} published. Create a session for it under Sessions.`);
              await exam.reload();
            }}
          >
            Publish a new version
          </ActionButton>
        )
      }
    >
      <ErrorText error={exam.error} />
      {publishResult && (
        <p className="banner ok" role="status">
          {publishResult}
        </p>
      )}
      <Loading loading={exam.loading}>
        {d && (
          <>
            <p>
              <Badge value={d.status} /> {d.versions.length ? `${d.versions.length} published version${d.versions.length > 1 ? 's' : ''}` : 'Not published yet'}
            </p>
            <Settings exam={d} onSaved={exam.reload} />
            <Questions exam={d} onChanged={exam.reload} />
            {d.versions.length > 0 && (
              <section className="card">
                <h2>Published versions</h2>
                <p className="muted small">Each version is signed and never changes, so candidates always sit exactly what was published.</p>
                <div className="table-wrap">
        <table>
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Published</th>
                      <th>Fingerprint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.versions.map((v) => (
                      <tr key={v.id}>
                        <td>{v.version}</td>
                        <td>{formatDateTime(v.publishedAt)}</td>
                        <td className="mono small">{v.manifestSha256.slice(0, 16)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
        </div>
              </section>
            )}
          </>
        )}
      </Loading>
    </Page>
  );
}

const POLICY_TEXT: Record<Policy, string> = {
  flag: 'Record breaks for review only',
  warn_then_submit: 'Warn, then end the exam after too many breaks',
  submit_immediately: 'End the exam at the first break',
};

function Settings({ exam, onSaved }: { exam: ExamDetailData; onSaved: () => void }) {
  const [c, setC] = useState(() => withDefaults(exam.config));
  const [saved, setSaved] = useState(false);
  useEffect(() => setC(withDefaults(exam.config)), [exam.config]);
  const sec = (patch: Partial<Config['security']>) => setC({ ...c, security: { ...c.security, ...patch } });
  const dev = (patch: Partial<Config['device']>) => setC({ ...c, device: { ...c.device, ...patch } });
  const tim = (patch: Partial<Config['timing']>) => setC({ ...c, timing: { ...c.timing, ...patch } });

  return (
    <Form
      submitText="Save settings"
      onSubmit={async () => {
        setSaved(false);
        await request('PATCH', `/exams/${exam.id}`, { config: c });
        setSaved(true);
        onSaved();
      }}
    >
      <h2>Settings</h2>
      <p className="muted small">Changes apply to the next published version. Versions already published keep their settings.</p>

      <h3>Timing</h3>
      <div className="grid3">
        <Field label="Duration in minutes">
          <input type="number" min={1} max={1440} value={c.timing.durationMinutes ?? ''} onChange={(e) => tim({ durationMinutes: Number(e.target.value) || undefined })} required />
        </Field>
        <Field label="Start window in minutes" hint="How long after the session starts a candidate may still begin.">
          <input type="number" min={0} max={1440} value={c.timing.startWindowMinutes} onChange={(e) => tim({ startWindowMinutes: Number(e.target.value) })} />
        </Field>
        <Field label="Late entry in minutes" hint="Extra minutes on top of the start window.">
          <input type="number" min={0} max={1440} value={c.timing.lateEntryMinutes} onChange={(e) => tim({ lateEntryMinutes: Number(e.target.value) })} />
        </Field>
      </div>
      <Check label="Candidates may go back to earlier questions" checked={c.navigation.allowBacktrack} onChange={(v) => setC({ ...c, navigation: { ...c.navigation, allowBacktrack: v } })} />

      <h3>Exam rules</h3>
      <Check label="Full screen required" checked={c.security.fullscreen} onChange={(v) => sec({ fullscreen: v })} hint="Leaving full screen counts as a break." />
      <Check label="Block copy and paste" checked={c.security.blockClipboard} onChange={(v) => sec({ blockClipboard: v })} />
      <Check label="Lock the computer (secure mode)" checked={c.security.kiosk} onChange={(v) => sec({ kiosk: v })} />
      <Check label="Camera" checked={c.security.camera} onChange={(v) => sec({ camera: v })} />
      <Check label="Microphone" checked={c.security.microphone} onChange={(v) => sec({ microphone: v })} />
      <Check label="Screen recording" checked={c.security.screenCapture} onChange={(v) => sec({ screenCapture: v })} />
      <div className="grid2">
        <Field label="When a rule is broken" hint="Breaks: leaving full screen, switching window or tab, trying to close, adding a screen.">
          <select value={c.security.violationPolicy} onChange={(e) => sec({ violationPolicy: e.target.value as Policy })}>
            {(Object.keys(POLICY_TEXT) as Policy[]).map((p) => (
              <option key={p} value={p}>
                {POLICY_TEXT[p]}
              </option>
            ))}
          </select>
        </Field>
        {c.security.violationPolicy === 'warn_then_submit' && (
          <Field label="Breaks allowed before the exam ends">
            <input type="number" min={1} max={20} value={c.security.maxViolations} onChange={(e) => sec({ maxViolations: Number(e.target.value) })} />
          </Field>
        )}
      </div>

      <h3>Devices</h3>
      <Check
        label="Laptops and desktops must use the ExamGuard desktop app"
        checked={c.device.requireDesktopApp}
        onChange={(v) => dev({ requireDesktopApp: v })}
        hint="Phones, tablets and Chromebooks still use the browser."
      />
      <Check label="Allow a second screen" checked={c.device.allowExternalMonitors} onChange={(v) => dev({ allowExternalMonitors: v })} />
      <Check label="Allow virtual machines" checked={c.device.allowVirtualMachines} onChange={(v) => dev({ allowVirtualMachines: v })} />
      <fieldset className="os">
        <legend>Allowed systems</legend>
        {OS.map((os) => (
          <Check
            key={os}
            label={{ windows: 'Windows', macos: 'macOS', linux: 'Linux', chromeos: 'ChromeOS', android: 'Android', ios: 'iPhone and iPad' }[os]}
            checked={c.device.supportedOs.includes(os)}
            onChange={(v) => dev({ supportedOs: v ? [...c.device.supportedOs, os] : c.device.supportedOs.filter((o) => o !== os) })}
          />
        ))}
      </fieldset>
      <Field label="Free storage needed, in MB">
        <input type="number" min={0} value={c.device.minFreeStorageMb} onChange={(e) => dev({ minFreeStorageMb: Number(e.target.value) })} />
      </Field>
      {saved && (
        <p className="banner ok" role="status">
          Settings saved.
        </p>
      )}
    </Form>
  );
}

type QuestionType = 'mcq' | 'multiple_response' | 'true_false' | 'short_answer' | 'essay';
const TYPE_TEXT: Record<QuestionType, string> = {
  mcq: 'Multiple choice (one answer)',
  multiple_response: 'Multiple choice (several answers)',
  true_false: 'True or false',
  short_answer: 'Short answer (marked by a person)',
  essay: 'Essay (marked by a person)',
};

function Questions({ exam, onChanged }: { exam: ExamDetailData; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const items = exam.questions.map((q) => ({ questionId: q.id, points: q.points }));
  const total = exam.questions.reduce((s, q) => s + q.points, 0);

  async function save(next: { questionId: string; points: number }[]) {
    await request('PUT', `/exams/${exam.id}/questions`, { items: next });
    onChanged();
  }

  return (
    <section className="card">
      <div className="row spread">
        <h2>Questions ({exam.questions.length}, {total} marks)</h2>
        <button onClick={() => setAdding(!adding)}>Add a question</button>
      </div>
      {adding && (
        <NewQuestion
          onCancel={() => setAdding(false)}
          onCreated={async (questionId, points) => {
            await save([...items, { questionId, points }]);
            setAdding(false);
          }}
        />
      )}
      {exam.questions.length === 0 ? (
        <p className="muted">No questions yet.</p>
      ) : (
        <ol className="questions">
          {exam.questions.map((q, i) => (
            <li key={q.id}>
              <div>
                <strong>{q.prompt}</strong>
                <p className="muted small">
                  {TYPE_TEXT[q.type as QuestionType] ?? label(q.type)} · {q.points} {q.points === 1 ? 'mark' : 'marks'}
                </p>
              </div>
              <div className="row">
                <ActionButton className="small" disabled={i === 0} onClick={() => save(move(items, i, i - 1))}>
                  ↑
                </ActionButton>
                <ActionButton className="small" disabled={i === items.length - 1} onClick={() => save(move(items, i, i + 1))}>
                  ↓
                </ActionButton>
                <ActionButton className="small" confirm="Remove this question from the exam?" onClick={() => save(items.filter((_, j) => j !== i))}>
                  Remove
                </ActionButton>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

function NewQuestion({ onCreated, onCancel }: { onCreated: (id: string, points: number) => Promise<void>; onCancel: () => void }) {
  const [type, setType] = useState<QuestionType>('mcq');
  const [prompt, setPrompt] = useState('');
  const [points, setPoints] = useState(1);
  const [options, setOptions] = useState([
    { label: '', isCorrect: true },
    { label: '', isCorrect: false },
  ]);
  const choice = type === 'mcq' || type === 'multiple_response';

  function changeType(t: QuestionType) {
    setType(t);
    if (t === 'true_false') setOptions([{ label: 'True', isCorrect: true }, { label: 'False', isCorrect: false }]);
    else if (t === 'mcq' || t === 'multiple_response') setOptions([{ label: '', isCorrect: true }, { label: '', isCorrect: false }]);
  }

  return (
    <Form
      submitText="Add to exam"
      onCancel={onCancel}
      onSubmit={async () => {
        const body = {
          type,
          prompt: prompt.trim(),
          options: choice || type === 'true_false' ? options.map((o) => ({ label: o.label.trim(), isCorrect: o.isCorrect })) : [],
        };
        const created = await request<{ id: string }>('POST', '/questions', body);
        await onCreated(created.id, points);
      }}
    >
      <div className="grid2">
        <Field label="Type">
          <select value={type} onChange={(e) => changeType(e.target.value as QuestionType)}>
            {(Object.keys(TYPE_TEXT) as QuestionType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_TEXT[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Marks">
          <input type="number" min={0} max={1000} step="0.5" value={points} onChange={(e) => setPoints(Number(e.target.value))} />
        </Field>
      </div>
      <Field label="Question">
        <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
      </Field>
      {(choice || type === 'true_false') && (
        <fieldset>
          <legend>Options, with the correct {type === 'multiple_response' ? 'ones' : 'one'} ticked</legend>
          {options.map((o, i) => (
            <div className="row option" key={i}>
              <input
                type={type === 'multiple_response' ? 'checkbox' : 'radio'}
                name="correct"
                aria-label={`Option ${i + 1} is correct`}
                checked={o.isCorrect}
                onChange={(e) =>
                  setOptions(options.map((x, j) => (type === 'multiple_response' ? (j === i ? { ...x, isCorrect: e.target.checked } : x) : { ...x, isCorrect: j === i })))
                }
              />
              <input
                aria-label={`Option ${i + 1}`}
                value={o.label}
                readOnly={type === 'true_false'}
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                required
              />
              {choice && options.length > 2 && (
                <button type="button" className="small" onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {choice && options.length < 26 && (
            <button type="button" className="small" onClick={() => setOptions([...options, { label: '', isCorrect: false }])}>
              Add an option
            </button>
          )}
        </fieldset>
      )}
    </Form>
  );
}
