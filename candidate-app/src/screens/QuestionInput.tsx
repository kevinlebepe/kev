import type { AnswerResponse, ManifestQuestion } from '../lib/types';

// Text is sent a moment after typing stops; choices are sent straight away.
export const TYPING_DELAY_MS = 800;

export function isAnswered(response: AnswerResponse | undefined): boolean {
  if (!response) return false;
  if ('optionId' in response) return true;
  if ('optionIds' in response) return response.optionIds.length > 0;
  return response.text.trim().length > 0;
}

export function QuestionInput({
  question,
  value,
  onChange,
}: {
  question: ManifestQuestion;
  value: AnswerResponse | undefined;
  onChange: (response: AnswerResponse, delayMs: number) => void;
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
    default:
      return (
        <p className="error" role="alert">
          This question type is not supported by this version of the application. Tell your invigilator.
        </p>
      );
  }
}
