import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Bold, Code, Heading1, Heading2, Italic, Link, List, Quote, Eye, Pencil } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import { MarkdownContent } from './MarkdownContent';
import styles from '../../../styles/modules/knowledge.module.css';

type Tool = {
  key: string;
  icon: ReactNode;
  title: string;
  wrap?: string;
  prefix?: string;
};

function applyTool(value: string, start: number, end: number, tool: Tool): { text: string; cursor: number } {
  const selected = value.slice(start, end);
  if (tool.prefix) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const text = value.slice(0, lineStart) + tool.prefix + value.slice(lineStart);
    return { text, cursor: start + tool.prefix.length };
  }
  if (tool.wrap) {
    const text = value.slice(0, start) + tool.wrap + selected + tool.wrap + value.slice(end);
    return { text, cursor: start + tool.wrap.length + selected.length + tool.wrap.length };
  }
  return { text: value, cursor: start };
}

export function MarkdownEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const tools: Tool[] = [
    { key: 'h1', icon: <Heading1 size={15} />, title: t('kb_tool_h1'), prefix: '# ' },
    { key: 'h2', icon: <Heading2 size={15} />, title: t('kb_tool_h2'), prefix: '## ' },
    { key: 'bold', icon: <Bold size={15} />, title: t('kb_tool_bold'), wrap: '**' },
    { key: 'italic', icon: <Italic size={15} />, title: t('kb_tool_italic'), wrap: '*' },
    { key: 'code', icon: <Code size={15} />, title: t('kb_tool_code'), wrap: '`' },
    { key: 'list', icon: <List size={15} />, title: t('kb_tool_list'), prefix: '- ' },
    { key: 'quote', icon: <Quote size={15} />, title: t('kb_tool_quote'), prefix: '> ' },
    { key: 'link', icon: <Link size={15} />, title: t('kb_tool_link'), wrap: '[' },
  ];

  const runTool = (tool: Tool) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const { text, cursor } = applyTool(value, ta.selectionStart, ta.selectionEnd, tool);
    onChange(text);
    window.setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(cursor, cursor);
    }, 0);
  };

  return (
    <div className={styles.editor}>
      <div className={styles.editorToolbar} role="toolbar" aria-label={t('kb_editor_toolbar')}>
        {tools.map((tool) => (
          <button
            key={tool.key}
            type="button"
            title={tool.title}
            aria-label={tool.title}
            className={styles.editorTool}
            onClick={() => runTool(tool)}
          >
            {tool.icon}
          </button>
        ))}
        <button
          type="button"
          className={styles.editorToggle}
          onClick={() => setPreview((v) => !v)}
          aria-pressed={preview}
        >
          {preview ? <Pencil size={14} /> : <Eye size={14} />}
          {preview ? t('kb_edit_md') : t('kb_preview')}
        </button>
      </div>
      {preview ? (
        <div className={styles.editorPreview}>
          <MarkdownContent content={value} />
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          className={styles.editorTextarea}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t('kb_solution_placeholder')}
          aria-label={t('kb_field_solution')}
        />
      )}
    </div>
  );
}
