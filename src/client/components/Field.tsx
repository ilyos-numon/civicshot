import '../styles/base.css';

export interface FieldProps {
  label: string;
  value: string;
  onEdit?: () => void;
  hint?: string;
  /** 자동으로 채운 값이면 true — "(자동)" 표기 */
  auto?: boolean;
}

export function Field({ label, value, onEdit, hint, auto }: FieldProps) {
  const empty = value.trim() === '';
  return (
    <div className="cs-field">
      <span className="cs-field__label">{label}</span>
      <span className={`cs-field__value${empty ? ' cs-field__value--empty' : ''}`}>
        {empty ? '확인이 필요해요' : value}
        {!empty && auto && <span className="cs-field__auto">(자동)</span>}
        {hint && <span className="cs-field__hint">{hint}</span>}
      </span>
      {onEdit ? (
        <button type="button" className="cs-field__edit" onClick={onEdit} aria-label={`${label} 고치기`}>
          고치기 ▸
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
    </div>
  );
}
