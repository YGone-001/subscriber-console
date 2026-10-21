import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FileText, Paperclip, Save, X } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import { OperationNotice } from '../../components/ui/OperationFeedback';
import { useI18n } from '../../providers/I18nProvider';
import { MutationApiError } from '../../lib/api/mutation-client';
import { MarkdownEditor } from './components/MarkdownEditor';
import { createEntry, fetchEntry, fetchKnowledgeMeta, updateEntry, uploadKnowledgeFile } from './knowledge-api';
import { fileKindLabel, formatFileSize } from './knowledge-format';
import type { Attachment, KnowledgeMeta } from './types';
import styles from '../../styles/modules/knowledge.module.css';

type AttachmentDraft = Attachment;

export function KnowledgeEditorPage() {
  const { entryId } = useParams<{ entryId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const isEdit = Boolean(entryId);

  const [title, setTitle] = useState('');
  const [protocol, setProtocol] = useState('General');
  const [tagsText, setTagsText] = useState('');
  const [phenomenon, setPhenomenon] = useState('');
  const [rootCause, setRootCause] = useState('');
  const [solution, setSolution] = useState('');
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [revision, setRevision] = useState(0);
  const [meta, setMeta] = useState<KnowledgeMeta | null>(null);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void fetchKnowledgeMeta().then(setMeta).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isEdit || !entryId) return;
    fetchEntry(entryId)
      .then((entry) => {
        setTitle(entry.title);
        setProtocol(entry.protocol);
        setTagsText(entry.tags.join(', '));
        setPhenomenon(entry.phenomenon);
        setRootCause(entry.rootCause);
        setSolution(entry.solution);
        setAttachments(entry.attachments);
        setRevision(entry.revision);
      })
      .catch(() => setError(t('kb_error_body')))
      .finally(() => setLoading(false));
  }, [isEdit, entryId, t]);

  const markDirty = (fn: () => void) => {
    fn();
    setDirty(true);
  };

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const protocols = useMemo(() => (meta?.protocols?.length ? meta.protocols : ['General']), [meta]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const uploaded = await uploadKnowledgeFile(file);
      setAttachments((prev) => [...prev, { ...uploaded }]);
      setDirty(true);
    } catch (err) {
      setError(err instanceof MutationApiError ? err.message : t('kb_upload_failed'));
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  const handleSave = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    const payload = {
      title: title.trim(),
      protocol: protocol === 'General' ? undefined : protocol,
      phenomenon,
      rootCause,
      solution,
      tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
      attachmentFileIds: attachments.map((a) => a.fileId),
    };
    try {
      if (isEdit && entryId) {
        await updateEntry(entryId, { ...payload, expectedRevision: revision });
      } else {
        await createEntry(payload);
      }
      navigate('/knowledge');
    } catch (err) {
      if (err instanceof MutationApiError && err.status === 409) {
        setError(t('kb_revision_conflict'));
      } else if (err instanceof MutationApiError) {
        setError(err.message);
      } else {
        setError(t('kb_save_failed'));
      }
      setSaving(false);
    }
  };

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('kb_page_eyebrow')}
        icon={<FileText size={24} />}
        title={isEdit ? t('kb_edit_title') : t('kb_new_title')}
        description={t('kb_editor_description')}
        actions={
          <div className={styles.headerActions}>
            <Link to={isEdit && entryId ? `/knowledge/${entryId}` : '/knowledge'} className={styles.backButton}>
              <ArrowLeft size={15} /> {t('kb_back')}
            </Link>
            <button type="button" className={styles.newButton} onClick={handleSave} disabled={saving || !title.trim()}>
              <Save size={15} /> {saving ? t('saving') : t('save')}
            </button>
          </div>
        }
      />

      {error && <OperationNotice tone="danger" message={error} onClose={() => setError(null)} />}

      {loading ? (
        <div className={styles.loading}>{t('loading')}</div>
      ) : (
        <div className={styles.editorLayout}>
          <div className={styles.editorMain}>
            <section className={styles.card}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('kb_field_title')}</span>
                <input
                  className={styles.input}
                  value={title}
                  onChange={(event) => markDirty(() => setTitle(event.target.value))}
                  placeholder={t('kb_title_placeholder')}
                />
              </label>
            </section>

            <section className={styles.card} data-tone="danger">
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('kb_field_phenomenon')}</span>
                <textarea
                  className={styles.textarea}
                  rows={3}
                  value={phenomenon}
                  onChange={(event) => markDirty(() => setPhenomenon(event.target.value))}
                  placeholder={t('kb_phenomenon_placeholder')}
                />
              </label>
            </section>

            <section className={styles.card} data-tone="warning">
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('kb_field_root_cause')}</span>
                <textarea
                  className={styles.textarea}
                  rows={3}
                  value={rootCause}
                  onChange={(event) => markDirty(() => setRootCause(event.target.value))}
                  placeholder={t('kb_root_cause_placeholder')}
                />
              </label>
            </section>

            <section className={styles.card}>
              <span className={styles.fieldLabel}>{t('kb_field_solution')}</span>
              <MarkdownEditor value={solution} onChange={(value) => markDirty(() => setSolution(value))} />
            </section>
          </div>

          <div className={styles.editorSide}>
            <section className={styles.card}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('kb_field_protocol')}</span>
                <select className={styles.input} value={protocol} onChange={(event) => markDirty(() => setProtocol(event.target.value))}>
                  {protocols.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('kb_field_tags')}</span>
                <input
                  className={styles.input}
                  value={tagsText}
                  onChange={(event) => markDirty(() => setTagsText(event.target.value))}
                  placeholder={t('kb_tag_placeholder')}
                />
              </label>
            </section>

            <section className={styles.card}>
              <div className={styles.cardHead}>
                <span className={styles.fieldLabel}>{t('kb_attachments')}</span>
                <label className={styles.attachButton}>
                  <Paperclip size={13} /> {uploading ? t('saving') : t('kb_attachment_add')}
                  <input type="file" className={styles.hiddenInput} onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleUpload(file);
                    event.target.value = '';
                  }} />
                </label>
              </div>
              {attachments.length === 0 ? (
                <p className={styles.attachEmpty}>{t('kb_attachment_empty')}</p>
              ) : (
                <ul className={styles.attachList}>
                  {attachments.map((file, index) => (
                    <li key={file.fileId} className={styles.attachItem}>
                      <span className={styles.attachKind}>{fileKindLabel(file.kind)}</span>
                      <span className={styles.attachName} title={file.originalName}>{file.originalName}</span>
                      <span className={styles.attachSize}>{formatFileSize(file.size)}</span>
                      <button type="button" className={styles.attachRemove} aria-label={t('kb_attachment_remove')} onClick={() => removeAttachment(index)}>
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
