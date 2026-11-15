import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useSWRConfig } from 'swr';
import { ArrowLeft, FileText, Paperclip, Save, X } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import { EmptyState, OperationNotice } from '../../components/ui/OperationFeedback';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '../../components/ui/UnsavedChangesGuard';
import { useI18n } from '../../providers/I18nProvider';
import { MarkdownEditor } from './components/MarkdownEditor';
import { TagInput } from './components/TagInput';
import { resolveReturnTo, withReturnTo } from '../../lib/return-to';
import { attachmentUrl, createEntry, deleteKnowledgeFile, fetchEntry, fetchKnowledgeMeta, isKnowledgeEntryKey, updateEntry, uploadKnowledgeFile } from './knowledge-api';
import { knowledgeErrorMessage, knowledgeReadErrorMessage } from './knowledge-errors';
import { extractSolutionImageIds, fileKindLabel, formatFileSize } from './knowledge-format';
import type { Attachment, KnowledgeMeta } from './types';
import styles from '../../styles/modules/knowledge.module.css';

type AttachmentDraft = Attachment;

const ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log,.pcap,.pcapng';
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const TITLE_MAX = 200;
const TEXT_MAX = 4000;
const SOLUTION_MAX = 200 * 1024;

export function KnowledgeEditorPage() {
  const { entryId } = useParams<{ entryId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { mutate } = useSWRConfig();
  const { t } = useI18n();
  const isEdit = Boolean(entryId);
  const returnTo = resolveReturnTo(location.search, '/knowledge', ['/knowledge']);

  const [title, setTitle] = useState('');
  const [protocol, setProtocol] = useState('General');
  const [tags, setTags] = useState<string[]>([]);
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
  const [titleError, setTitleError] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [dirty, setDirty] = useState(false);
  const persistedFileIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    void fetchKnowledgeMeta().then(setMeta).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isEdit || !entryId) {
      setLoadFailed(false);
      return;
    }
    setLoading(true);
    setLoadFailed(false);
    fetchEntry(entryId)
      .then((entry) => {
        setTitle(entry.title);
        setProtocol(entry.protocol);
        setTags(entry.tags);
        setPhenomenon(entry.phenomenon);
        setRootCause(entry.rootCause);
        setSolution(entry.solution);
        setAttachments(entry.attachments);
        setRevision(entry.revision);
        persistedFileIds.current = new Set(entry.attachments.map((file) => file.fileId));
      })
      .catch((err) => {
        setLoadError(err);
        setLoadFailed(true);
      })
      .finally(() => setLoading(false));
  }, [isEdit, entryId, t, reloadToken]);

  const markDirty = (fn: () => void) => {
    fn();
    setDirty(true);
  };

  // Draft autosave protects long new entries from accidental loss. Edit mode is
  // excluded: the server document is authoritative there and revision CAS guards
  // concurrent changes.
  const draftKey = `kb-draft:${entryId ?? 'new'}`;
  const restoredRef = useRef(false);
  useEffect(() => {
    if (isEdit || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (!raw) return;
      const draft = JSON.parse(raw) as Partial<{ title: string; protocol: string; tags: string[]; phenomenon: string; rootCause: string; solution: string }>;
      if (typeof draft.title === 'string') setTitle(draft.title);
      if (typeof draft.protocol === 'string') setProtocol(draft.protocol);
      if (Array.isArray(draft.tags)) setTags(draft.tags);
      if (typeof draft.phenomenon === 'string') setPhenomenon(draft.phenomenon);
      if (typeof draft.rootCause === 'string') setRootCause(draft.rootCause);
      if (typeof draft.solution === 'string') setSolution(draft.solution);
      setDirty(true);
    } catch {
      /* A corrupt draft is ignored; the editor starts empty. */
    }
  }, [isEdit, draftKey]);

  useEffect(() => {
    if (isEdit) return;
    const handle = window.setTimeout(() => {
      try {
        window.localStorage.setItem(draftKey, JSON.stringify({ title, protocol, tags, phenomenon, rootCause, solution }));
      } catch {
        /* localStorage may be unavailable; autosave is best-effort. */
      }
    }, 800);
    return () => window.clearTimeout(handle);
  }, [isEdit, draftKey, title, protocol, tags, phenomenon, rootCause, solution]);

  const unsavedChanges = useUnsavedChangesGuard(dirty, () => setDirty(false));

  const protocols = useMemo(() => (meta?.protocols?.length ? meta.protocols : ['General']), [meta]);
  const maxFileBytes = meta?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxAttachments = meta?.maxAttachments ?? 10;

  const handleUpload = async (file: File) => {
    setError(null);
    if (attachments.length >= maxAttachments) {
      setError(t('kb_attachment_limit', { max: maxAttachments }));
      return;
    }
    if (file.size > maxFileBytes) {
      setError(t('kb_file_too_large', { size: formatFileSize(maxFileBytes) }));
      return;
    }
    setUploading(true);
    try {
      const uploaded = await uploadKnowledgeFile(file);
      setAttachments((prev) => [...prev, { ...uploaded }]);
      setDirty(true);
    } catch (err) {
      setError(knowledgeErrorMessage(err, t, 'kb_upload_failed'));
    } finally {
      setUploading(false);
    }
  };

  const handleInlineImage = async (file: File): Promise<{ url: string; name: string } | null> => {
    setError(null);
    if (attachments.length >= maxAttachments) {
      setError(t('kb_attachment_limit', { max: maxAttachments }));
      return null;
    }
    if (file.size > maxFileBytes) {
      setError(t('kb_file_too_large', { size: formatFileSize(maxFileBytes) }));
      return null;
    }
    try {
      const uploaded = await uploadKnowledgeFile(file);
      /* An inline image is still an attachment: it must be claimed by the entry
       * on save, otherwise the janitor treats it as an unbound upload and the
       * Markdown image breaks after the cleanup window. */
      setAttachments((prev) => [...prev, { ...uploaded }]);
      setDirty(true);
      return { url: attachmentUrl(uploaded.fileId), name: uploaded.originalName };
    } catch (err) {
      setError(knowledgeErrorMessage(err, t, 'kb_upload_failed'));
      return null;
    }
  };

  const removeAttachment = (index: number) => {
    const removed = attachments[index];
    if (!removed) return;
    if (extractSolutionImageIds(solution).includes(removed.fileId.toLowerCase())) {
      setError(t('kb_image_still_referenced'));
      return;
    }
    if (!persistedFileIds.current.has(removed.fileId)) {
      // Newly uploaded files are unbound until save; remove them immediately
      // instead of waiting for the 24h janitor window.
      void deleteKnowledgeFile(removed.fileId).catch(() => setError(t('kb_file_delete_failed')));
    }
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  const handleSave = async () => {
    if (!title.trim()) {
      setTitleError(true);
      setError(t('kb_title_required'));
      return;
    }
    setTitleError(false);
    const claimed = new Set(attachments.map((a) => a.fileId.toLowerCase()));
    const orphan = extractSolutionImageIds(solution).find((id) => !claimed.has(id));
    if (orphan) {
      setError(t('kb_image_not_attached'));
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      title: title.trim(),
      protocol: protocol === 'General' ? undefined : protocol,
      phenomenon,
      rootCause,
      solution,
      tags,
      attachmentFileIds: attachments.map((a) => a.fileId),
    };
    try {
      const saved = isEdit && entryId
        ? await updateEntry(entryId, { ...payload, expectedRevision: revision })
        : await createEntry(payload);
      setDirty(false);
      try {
        window.localStorage.removeItem(draftKey);
      } catch {
        /* Draft cleanup is best-effort. */
      }
      // Invalidate cached list and detail reads so a new or changed entry is
      // visible when the destination mounts inside SWR's dedupe window.
      try {
        await mutate(isKnowledgeEntryKey, undefined, { revalidate: true });
        await mutate('/api/knowledge/meta');
      } catch {
        /* Routes still revalidate when they mount. */
      }
      navigate(withReturnTo(`/knowledge/${saved.id}`, returnTo), { state: { knowledgeSaved: true } });
    } catch (err) {
      setError(knowledgeErrorMessage(err, t));
      setSaving(false);
    }
  };

  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!saving) void saveRef.current();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [saving]);

  return (
    <div className={`container animate-fade-in ${dirty ? styles.editorDirty : ''}`}>
      <PageHeader
        eyebrow={t('kb_page_eyebrow')}
        icon={<FileText size={24} />}
        title={isEdit ? t('kb_edit_title') : t('kb_new_title')}
        description={t('kb_editor_description')}
        actions={
          <div className={styles.headerActions}>
            <Link to={isEdit && entryId ? withReturnTo(`/knowledge/${entryId}`, returnTo) : returnTo} className={styles.backButton}>
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
      ) : loadFailed ? (
        <EmptyState
          icon={<FileText size={40} />}
          title={t('kb_error_title')}
          description={knowledgeReadErrorMessage(loadError, t, 'kb_error_body')}
          action={(
            <button
              type="button"
              className={styles.searchButton}
              onClick={() => {
                setError(null);
                setReloadToken((value) => value + 1);
              }}
            >
              {t('kb_retry')}
            </button>
          )}
        />
      ) : (
        <div className={styles.editorLayout}>
          <div className={styles.editorMain}>
            <section className={styles.card}>
              <label className={styles.field} htmlFor="kb-entry-title">
                <span className={styles.fieldLabel}>{t('kb_field_title')}</span>
                <input
                  id="kb-entry-title"
                  className={styles.input}
                  value={title}
                  maxLength={TITLE_MAX}
                  aria-invalid={titleError}
                  aria-describedby="kb-title-count"
                  onChange={(event) => {
                    setTitleError(false);
                    markDirty(() => setTitle(event.target.value));
                  }}
                  placeholder={t('kb_title_placeholder')}
                />
                <span id="kb-title-count" className={styles.charCount}>
                  {t('kb_char_count', { count: title.length, max: TITLE_MAX })}
                </span>
              </label>
            </section>

            <section className={styles.card} data-tone="danger">
              <label className={styles.field} htmlFor="kb-entry-phenomenon">
                <span className={styles.fieldLabel}>{t('kb_field_phenomenon')}</span>
                <textarea
                  id="kb-entry-phenomenon"
                  className={styles.textarea}
                  rows={3}
                  value={phenomenon}
                  maxLength={TEXT_MAX}
                  aria-describedby="kb-phenomenon-count"
                  onChange={(event) => markDirty(() => setPhenomenon(event.target.value))}
                  placeholder={t('kb_phenomenon_placeholder')}
                />
                <span id="kb-phenomenon-count" className={styles.charCount}>
                  {t('kb_char_count', { count: phenomenon.length, max: TEXT_MAX })}
                </span>
              </label>
            </section>

            <section className={styles.card} data-tone="warning">
              <label className={styles.field} htmlFor="kb-entry-root-cause">
                <span className={styles.fieldLabel}>{t('kb_field_root_cause')}</span>
                <textarea
                  id="kb-entry-root-cause"
                  className={styles.textarea}
                  rows={3}
                  value={rootCause}
                  maxLength={TEXT_MAX}
                  aria-describedby="kb-root-cause-count"
                  onChange={(event) => markDirty(() => setRootCause(event.target.value))}
                  placeholder={t('kb_root_cause_placeholder')}
                />
                <span id="kb-root-cause-count" className={styles.charCount}>
                  {t('kb_char_count', { count: rootCause.length, max: TEXT_MAX })}
                </span>
              </label>
            </section>

            <section className={styles.card}>
              <label className={styles.fieldLabel} htmlFor="kb-entry-solution">{t('kb_field_solution')}</label>
              <MarkdownEditor
                id="kb-entry-solution"
                describedBy="kb-solution-count"
                value={solution}
                onChange={(value) => markDirty(() => setSolution(value))}
                onUploadImage={handleInlineImage}
              />
              <span id="kb-solution-count" className={styles.charCount}>
                {t('kb_char_count', { count: solution.length, max: SOLUTION_MAX })}
              </span>
            </section>
          </div>

          <div className={styles.editorSide}>
            <section className={styles.card}>
              <label className={styles.field} htmlFor="kb-entry-protocol">
                <span className={styles.fieldLabel}>{t('kb_field_protocol')}</span>
                <select id="kb-entry-protocol" className={styles.input} value={protocol} onChange={(event) => markDirty(() => setProtocol(event.target.value))}>
                  {protocols.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="kb-entry-tags">{t('kb_field_tags')}</label>
                <TagInput
                  id="kb-entry-tags"
                  value={tags}
                  onChange={(next) => markDirty(() => setTags(next))}
                  suggestions={meta?.topTags.map((item) => item.tag) ?? []}
                  maxTags={meta?.maxTags ?? 20}
                  maxTagLength={meta?.maxTagLength ?? 32}
                  ariaLabel={t('kb_field_tags')}
                  placeholder={t('kb_tag_placeholder')}
                />
              </div>
            </section>

            <section className={styles.card}>
              <div className={styles.cardHead}>
                <span className={styles.fieldLabel}>{t('kb_attachments')}</span>
                <label className={styles.attachButton}>
                  <Paperclip size={13} /> {uploading ? t('kb_uploading') : t('kb_attachment_add')}
                  <input
                    type="file"
                    accept={ATTACHMENT_ACCEPT}
                    className={styles.hiddenInput}
                    disabled={uploading}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleUpload(file);
                      event.target.value = '';
                    }}
                  />
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
              <p className={styles.attachHint}>{t('kb_attachment_hint', { size: formatFileSize(maxFileBytes) })}</p>
            </section>
          </div>
        </div>
      )}

      {dirty && (
        <div className={styles.floatingSave} role="region" aria-label={t('kb_unsaved_changes')}>
          <span className={styles.floatingSaveText}>{t('kb_unsaved_changes')}</span>
          <button type="button" className={styles.newButton} onClick={handleSave} disabled={saving || !title.trim()}>
            <Save size={15} /> {saving ? t('saving') : t('save')}
          </button>
        </div>
      )}

      <UnsavedChangesDialog
        open={unsavedChanges.isPromptOpen}
        title={t('unsaved_changes_title')}
        description={t('unsaved_changes_description')}
        keepEditingLabel={t('unsaved_changes_keep_editing')}
        discardLabel={t('unsaved_changes_discard')}
        onKeepEditing={unsavedChanges.keepEditing}
        onDiscard={unsavedChanges.discardChanges}
      />
    </div>
  );
}
