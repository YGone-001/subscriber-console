import { useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode } from 'react';
import { Bold, Code, Eye, Heading1, Heading2, Heading3, Image as ImageIcon, Italic, Link, List, ListChecks, ListOrdered, Minus, Pencil, Quote, Strikethrough, Table } from 'lucide-react';
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
  if (tool.key === 'codeBlock') {
    const fence = '```';
    const text = `${value.slice(0, start)}\n${fence}\n${selected}\n${fence}\n${value.slice(end)}`;
    const cursor = start + 1 + fence.length + 1 + selected.length;
    return { text, selectionStart: cursor, selectionEnd: cursor };
  }
  if (tool.key === 'hr') {
    const insert = '\n---\n';
    const text = value.slice(0, start) + insert + value.slice(end);
    const cursor = start + insert.length;
    return { text, selectionStart: cursor, selectionEnd: cursor };
  }
  if (tool.key === 'table') {
    const insert = '\n| Column | Column |\n| --- | --- |\n| Cell | Cell |\n';
    const text = value.slice(0, start) + insert + value.slice(end);
    const cursor = start + insert.length;
    return { text, selectionStart: cursor, selectionEnd: cursor };
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

function firstImageFile(files: FileList | File[] | null | undefined): File | null {
  if (!files) return null;
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) return file;
  }
  return null;
}

function firstImageFromItems(items: DataTransferItemList | null): File | null {
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

type MarkdownEditorProps = {
  id?: string;
  describedBy?: string;
  placeholder?: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  onUploadImage?: (file: File) => Promise<{ url: string; name: string } | null>;
};

export function MarkdownEditor({ id, describedBy, placeholder, ariaLabel, value, onChange, onUploadImage }: MarkdownEditorProps) {
  const { t } = useI18n();
  const [preview, setPreview] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const tools: Tool[] = [
    { key: 'h1', icon: <Heading1 size={15} />, title: t('kb_tool_h1'), prefix: '# ' },
    { key: 'h2', icon: <Heading2 size={15} />, title: t('kb_tool_h2'), prefix: '## ' },
    { key: 'h3', icon: <Heading3 size={15} />, title: t('kb_tool_h3'), prefix: '### ' },
    { key: 'bold', icon: <Bold size={15} />, title: t('kb_tool_bold'), wrap: '**' },
    { key: 'italic', icon: <Italic size={15} />, title: t('kb_tool_italic'), wrap: '*' },
    { key: 'strike', icon: <Strikethrough size={15} />, title: t('kb_tool_strike'), wrap: '~~' },
    { key: 'code', icon: <Code size={15} />, title: t('kb_tool_code'), wrap: '`' },
    { key: 'list', icon: <List size={15} />, title: t('kb_tool_list'), prefix: '- ' },
    { key: 'ordered', icon: <ListOrdered size={15} />, title: t('kb_tool_ordered_list'), prefix: '1. ' },
    { key: 'task', icon: <ListChecks size={15} />, title: t('kb_tool_task_list'), prefix: '- [ ] ' },
    { key: 'quote', icon: <Quote size={15} />, title: t('kb_tool_quote'), prefix: '> ' },
    { key: 'link', icon: <Link size={15} />, title: t('kb_tool_link') },
    { key: 'codeBlock', icon: <Code size={15} />, title: t('kb_tool_code_block') },
    { key: 'table', icon: <Table size={15} />, title: t('kb_tool_table') },
    { key: 'hr', icon: <Minus size={15} />, title: t('kb_tool_hr') },
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

  const handleShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    const shortcutKey = key === 'b' ? 'bold' : key === 'i' ? 'italic' : key === 'k' ? 'link' : null;
    if (!shortcutKey) return;
    const tool = tools.find((item) => item.key === shortcutKey);
    if (tool) {
      event.preventDefault();
      runTool(tool);
    }
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

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onUploadImage) return;
    const file = firstImageFromItems(event.clipboardData?.items ?? null);
    if (!file) return;
    event.preventDefault();
    void uploadImage(file);
  };

  const handleDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    if (!onUploadImage) return;
    const file = firstImageFile(event.dataTransfer?.files);
    if (!file) return;
    event.preventDefault();
    void uploadImage(file);
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
          id={id}
          className={styles.editorTextarea}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleShortcut}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={(event) => {
            if (onUploadImage && event.dataTransfer?.types?.includes('Files')) event.preventDefault();
          }}
          placeholder={placeholder ?? t('kb_solution_placeholder')}
          aria-label={ariaLabel ?? t('kb_field_solution')}
          aria-describedby={describedBy}
        />
      )}
    </div>
  );
}
