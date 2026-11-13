import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { IconX } from '@/components/ui/icons';
import styles from './ModelsPage.module.scss';

export function Chip({
  value,
  kind,
  onRemove,
  disabled,
  title,
}: {
  value: string;
  kind?: 'allow' | 'deny' | 'combo' | 'unavailable';
  title?: string;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className={styles.chip} data-kind={kind} title={title}>
      {value}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={t('model_exposure.remove_entry', { value })}
          title={t('model_exposure.remove_entry', { value })}
        >
          <IconX size={12} />
        </button>
      ) : null}
    </span>
  );
}

/** Editable list of wildcard patterns shown as removable chips. */
export function PatternChips({
  label,
  values,
  onChange,
  kind,
  placeholder,
  disabled,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  kind: 'allow' | 'deny';
  placeholder?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) {
      onChange([...values, value]);
    }
    setDraft('');
  };
  return (
    <div className="form-group">
      <label>{label}</label>
      <div className={styles.chips}>
        {values.length === 0 ? (
          <span className={styles.muted}>{t('model_exposure.patterns_empty')}</span>
        ) : (
          values.map((value) => (
            <Chip
              key={value}
              value={value}
              kind={kind}
              disabled={disabled}
              onRemove={() => onChange(values.filter((item) => item !== value))}
            />
          ))
        )}
      </div>
      <div className={styles.patternInput}>
        <Input
          value={draft}
          placeholder={placeholder}
          aria-label={label}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button variant="secondary" size="sm" onClick={add} disabled={disabled || !draft.trim()}>
          {t('model_exposure.add_pattern')}
        </Button>
      </div>
    </div>
  );
}
