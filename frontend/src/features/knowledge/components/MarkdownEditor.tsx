import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Bold, Code, Heading1, Heading2, Image as ImageIcon, Italic, Link, List, Quote, Eye, Pencil } from 'lucide-react';
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

type ToolShape = Pick<Tool, 'key' | 'wrap' | 'prefix'>;

export type MarkdownEditResult = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

export function applyTool(
  value: string,
  start: number,
  end: number,
  tool: ToolShape,
  linkLabel = 'Link text',
): MarkdownEditResult {
  const selected = value.slice(start, end);
  if (tool.key === 'link') {
    const label = selected || linkLabel;
    const url = 'https://';
    const text = `${value.slice(0, start)}[${label}](${url})${value.slice(end)}`;
    const labelStart = start + 1;
    const labelEnd = labelStart + label.length;
    const urlStart = labelEnd + 2; // skip "]("
    if (!selected) {
      return { text, selectionStart: labelStart, selectionEnd: labelEnd };
    }
    return { text, selectionStart: urlStart, selectionEnd: urlStart + url.length };
  }
  if (tool.prefix) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const text = value.slice(0, lineStart) + tool.prefix + value.slice(lineStart);
    const cursor = start + tool.prefix.length;
    return { text, selectionStart: cursor, selectionEnd: cursor };
  }
  if (tool.wrap) {
    const text = value.slice(0, start) + tool.wrap + selected + tool.wrap + value.slice(end);
    const cursor = selected
      ? start + tool.wrap.length + selected.length + tool.wrap.length
      : start + tool.wrap.length;
    return { text, selectionStart: cursor, selectionEnd: cursor };
  }
  return { text: value, selectionStart: start, selectionEnd: end };
}

export function insertImage(
  value: string,
  start: number,
  end: number,
  url: string,
  alt: string,
): MarkdownEditResult {
  const label = alt.replace(/[[\]\r\n]/g, ' ').trim() || 'image';
  const before = value.slice(0, start);
  const after = value.slice(end);
  // Images are block-level in practice; isolate them so adjacent headings and
  // paragraphs keep their Markdown meaning.
  const lead = before === '' || before.endsWith('\n') ? '' : '\n\n';
  const trail = after === '' || after.startsWith('\n') ? '' : '\n\n';
  const image = `![${label}](${url})`;
  const text = before + lead + image + trail + after;
  const cursor = start + lead.length + image.length;
  return { text, selectionStart: cursor, selectionEnd: cursor };
}

type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onUploadImage?: (file: File) => Promise<{ url: string; name: string } | null>;
};

export function MarkdownEditor({ value, onChange, onUploadImage }: MarkdownEditorProps) {
  const { t } = useI18n();
  const [preview, setPreview] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const tools: Tool[] = [
    { key: 'h1', icon: <Heading1 size={15} />, title: t('kb_tool_h1'), prefix: '# ' },
    { key: 'h2', icon: <Heading2 size={15} />, title: t('kb_tool_h2'), prefix: '## ' },
    { key: 'bold', icon: <Bold size={15} />, title: t('kb_tool_bold'), wrap: '**' },
    { key: 'italic', icon: <Italic size={15} />, title: t('kb_tool_italic'), wrap: '*' },
    { key: 'code', icon: <Code size={15} />, title: t('kb_tool_code'), wrap: '`' },
    { key: 'list', icon: <List size={15} />, title: t('kb_tool_list'), prefix: '- ' },
    { key: 'quote', icon: <Quote size={15} />, title: t('kb_tool_quote'), prefix: '> ' },
    { key: 'link', icon: <Link size={15} />, title: t('kb_tool_link') },
  ];

  const runTool = (tool: Tool) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const result = applyTool(value, ta.selectionStart, ta.selectionEnd, tool, t('kb_link_text'));
    onChange(result.text);
    window.setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(result.selectionStart, result.selectionEnd);
    }, 0);
  };

  const uploadImage = async (file: File) => {
    const ta = textareaRef.current;
    if (!onUploadImage || !ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end);
    setImageUploading(true);
    try {
      const uploaded = await onUploadImage(file);
      if (!uploaded) return;
      const result = insertImage(ta.value, start, end, uploaded.url, selected || uploaded.name);
      onChange(result.text);
      window.setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(result.selectionStart, result.selectionEnd);
      }, 0);
    } finally {
      setImageUploading(false);
    }
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
        {onUploadImage && (
          <>
            <button
              type="button"
              title={t('kb_tool_image')}
              aria-label={t('kb_tool_image')}
              className={styles.editorTool}
              disabled={imageUploading || preview}
              aria-busy={imageUploading}
              onClick={() => imageInputRef.current?.click()}
            >
              <ImageIcon size={15} />
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,.gif,.webp"
              className={styles.hiddenInput}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void uploadImage(file);
              }}
            />
          </>
        )}
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
