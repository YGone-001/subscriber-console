import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import { mergeTags, splitTagInput } from '../knowledge-tags';
import styles from '../../../styles/modules/knowledge.module.css';

type TagInputProps = {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  maxTags?: number;
  maxTagLength?: number;
  ariaLabel: string;
  placeholder: string;
};

export function TagInput({
  value,
  onChange,
  suggestions = [],
  maxTags = 20,
  maxTagLength = 32,
  ariaLabel,
  placeholder,
}: TagInputProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const parts = splitTagInput(raw);
    if (parts.length === 0) {
      setDraft('');
      return;
    }
    const next = mergeTags(value, parts, maxTags, maxTagLength);
    if (next.length !== value.length) onChange(next);
    setDraft('');
  };

  const handleChange = (raw: string) => {
    if (!/[,，]/.test(raw)) {
      setDraft(raw);
      return;
    }
    const parts = raw.split(/[,，]/);
    const remainder = parts.pop() ?? '';
    const next = mergeTags(value, parts, maxTags, maxTagLength);
    if (next.length !== value.length) onChange(next);
    setDraft(remainder);
  };

  const addSuggestion = (tag: string) => {
    const next = mergeTags(value, [tag], maxTags, maxTagLength);
    if (next.length !== value.length) onChange(next);
    inputRef.current?.focus();
  };

  const availableSuggestions = suggestions
    .filter((tag) => !value.some((current) => current.toLowerCase() === tag.toLowerCase()))
    .slice(0, 8);

  return (
    <div className={styles.tagInput}>
      <div className={styles.tagInputField} onClick={() => inputRef.current?.focus()}>
        {value.map((tag) => (
          <span key={tag} className={styles.tagInputChip}>
            {tag}
            <button
              type="button"
              aria-label={t('kb_tag_remove', { tag })}
              onClick={(event) => {
                event.stopPropagation();
                onChange(value.filter((current) => current !== tag));
              }}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={draft}
          aria-label={ariaLabel}
          placeholder={value.length === 0 ? placeholder : undefined}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
              event.preventDefault();
              commit(draft);
            } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => commit(draft)}
        />
      </div>
      <div className={styles.tagInputMeta}>
        <span>{t('kb_tag_count', { count: value.length, max: maxTags })}</span>
        {availableSuggestions.length > 0 && (
          <span className={styles.tagSuggestions}>
            <span>{t('kb_tag_suggestions')}</span>
            {availableSuggestions.map((tag) => (
              <button key={tag} type="button" onClick={() => addSuggestion(tag)}>{tag}</button>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
