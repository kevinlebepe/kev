import { useState } from 'react';
import { sendBlobJson } from '../lib/api';
import type { AnswerResponse, ManifestQuestion } from '../lib/types';

// Text is sent a moment after typing stops; choices are sent straight away.
export const TYPING_DELAY_MS = 800;

export function isAnswered(response: AnswerResponse | undefined): boolean {
  if (!response) return false;
  if ('optionId' in response) return true;
  if ('optionIds' in response) return response.optionIds.length > 0;
  if ('fileId' in response) return true;
  return response.text.trim().length > 0;
}

const FILE_TYPES = '.pdf,.png,.jpg,.jpeg,.docx,application/pdf,image/png,image/jpeg,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Attaches a file: it is uploaded first, then the answer names it. */
function FileAnswer({
  attemptId,
  questionId,
  value,
  onChange,
}: {
  attemptId: string;
  questionId: string;
  value: AnswerResponse | undefined;
  onChange: (response: AnswerResponse, delayMs: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = value && 'fileId' in value ? value : null;
  return (
    <div className="file-answer">
      {current && (
        <p className="banner ok" role="status">
          ✓ Attached: {current.name ?? 'your file'}
        </p>
      )}
      <label>
        {current ? 'Replace the file' : 'Attach your file'} (PDF, picture or Word document, up to 10 MB)
        <input
          type="file"
          accept={FILE_TYPES}
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            if (file.size > MAX_FILE_BYTES) return setError('That file is larger than 10 MB.');
            setBusy(true);
            setError(null);
            try {
              const res = await sendBlobJson<{ fileId: string; name: string }>(`/attempts/${attemptId}/files/${questionId}`, file, {
                'x-file-name': file.name,
              });
              onChange({ fileId: res.fileId, name: res.name }, 0);
            } catch (err) {
              setError(`The file could not be attached: ${(err as Error).message}. Check your connection and try again.`);
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {busy && <p role="status">Uploading…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function QuestionInput({
  question,
  value,
  onChange,
  attemptId,
}: {
  question: ManifestQuestion;
  value: AnswerResponse | undefined;
  onChange: (response: AnswerResponse, delayMs: number) => void;
  /** Needed by file upload questions, which send the file before the answer. */
  attemptId?: string;
}) {
  switch (question.type) {
    case 'mcq':
    case 'true_false': {
      const chosen = value && 'optionId' in value ? value.optionId : null;
      return (
        <fieldset className="options">
          <legend className="sr-only">Choose one answer</legend>
          {question.options.map((o) => (
            <label key={o.id} className={`option ${chosen === o.id ? 'chosen' : ''}`}>
              <input type="radio" name={question.id} checked={chosen === o.id} onChange={() => onChange({ optionId: o.id }, 0)} />
              {o.label}
            </label>
          ))}
        </fieldset>
      );
    }
    case 'multiple_response': {
      const chosen = value && 'optionIds' in value ? value.optionIds : [];
      return (
        <fieldset className="options">
          <legend className="sr-only">Choose all answers that apply</legend>
          {question.options.map((o) => (
            <label key={o.id} className={`option ${chosen.includes(o.id) ? 'chosen' : ''}`}>
              <input
                type="checkbox"
                checked={chosen.includes(o.id)}
                onChange={(e) => {
                  const next = e.target.checked ? [...chosen, o.id] : chosen.filter((id) => id !== o.id);
                  // Keep the order the options are shown in.
                  onChange({ optionIds: question.options.map((x) => x.id).filter((id) => next.includes(id)) }, 0);
                }}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
      );
    }
    case 'short_answer':
      return (
        <input
          className="answer-line"
          type="text"
          maxLength={2000}
          aria-label="Your answer"
          value={value && 'text' in value ? value.text : ''}
          onChange={(e) => onChange({ text: e.target.value }, TYPING_DELAY_MS)}
        />
      );
    case 'essay':
      return (
        <textarea
          className="answer"
          rows={10}
          aria-label="Your answer"
          value={value && 'text' in value ? value.text : ''}
          onChange={(e) => onChange({ text: e.target.value }, TYPING_DELAY_MS)}
        />
      );
    case 'file_upload':
      if (attemptId) return <FileAnswer attemptId={attemptId} questionId={question.id} value={value} onChange={onChange} />;
      return null;
    default:
      return (
        <p className="error" role="alert">
          This question type is not supported by this version of the application. Tell your invigilator.
        </p>
      );
  }
}
