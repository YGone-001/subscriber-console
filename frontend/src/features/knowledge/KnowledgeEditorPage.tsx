import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useSWRConfig } from 'swr';
import { ArrowLeft, FileText, Paperclip, Save, X } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import { ConfirmActionPanel, EmptyState, OperationNotice } from '../../components/ui/OperationFeedback';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '../../components/ui/UnsavedChangesGuard';
import { useI18n } from '../../providers/I18nProvider';
import { MarkdownEditor } from './components/MarkdownEditor';
import { TagInput } from './components/TagInput';
import { resolveReturnTo, withReturnTo } from '../../lib/return-to';
import { MutationApiError } from '../../lib/api/mutation-client';
import { attachmentUrl, createEntry, deleteKnowledgeFile, fetchEntry, fetchKnowledgeMeta, isKnowledgeEntryKey, updateEntry, uploadKnowledgeFile } from './knowledge-api';
import { knowledgeErrorMessage, knowledgeReadErrorMessage } from './knowledge-errors';
import { extractSolutionImageIds, fileKindLabel, formatFileSize } from './knowledge-format';
import type { Attachment, KnowledgeEntry, KnowledgeMeta } from './types';
import styles from '../../styles/modules/knowledge.module.css';

type AttachmentDraft = Attachment;

type DraftPayload = {
  title: string;
  protocol: string;
  tags: string[];
  phenomenon: string;
  rootCause: string;
  solution: string;
  attachments: AttachmentDraft[];
  savedAt: string;
};

const ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log,.pcap,.pcapng';
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const TITLE_MAX = 200;
const TEXT_MAX = 4000;
const SOLUTION_MAX = 200 * 1024;

function readDraft(key: string): DraftPayload | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<DraftPayload>;
    return {
      title: typeof draft.title === 'string' ? draft.title : '',
      protocol: typeof draft.protocol === 'string' ? draft.protocol : 'General',
      tags: Array.isArray(draft.tags) ? draft.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      phenomenon: typeof draft.phenomenon === 'string' ? draft.phenomenon : '',
      rootCause: typeof draft.rootCause === 'string' ? draft.rootCause : '',
      solution: typeof draft.solution === 'string' ? draft.solution : '',
      attachments: Array.isArray(draft.attachments) ? draft.attachments : [],
      savedAt: typeof draft.savedAt === 'string' ? draft.savedAt : '',
    };
  } catch {
    return null;
  }
}

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
  const [draftCandidate, setDraftCandidate] = useState<DraftPayload | null>(null);
  const [draftChecked, setDraftChecked] = useState(isEdit);
  const [conflict, setConflict] = useState<KnowledgeEntry | null>(null);
  const [conflictReloading, setConflictReloading] = useState(false);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const persistedFileIds = useRef<Set<string>>(new Set());

  const applyEntry = useCallback((entry: KnowledgeEntry) => {
    setTitle(entry.title);
    setProtocol(entry.protocol);
    setTags(entry.tags);
    setPhenomenon(entry.phenomenon);
    setRootCause(entry.rootCause);
    setSolution(entry.solution);
    setAttachments(entry.attachments);
    setRevision(entry.revision);
    persistedFileIds.current = new Set(entry.attachments.map((file) => file.fileId));
  }, []);

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
      .then(applyEntry)
      .catch((err) => {
        setLoadError(err);
        setLoadFailed(true);
      })
      .finally(() => setLoading(false));
  }, [applyEntry, isEdit, entryId, reloadToken]);

  const markDirty = (fn: () => void) => {
    fn();
    setDirty(true);
  };

  // Draft autosave protects long new entries from accidental loss. It uses
// sessionStorage so tabs editing different entries do not overwrite each other;
// edit mode is excluded because the server document and revision CAS are
// authoritative there.
  const draftKey = `kb-draft:${entryId ?? 'new'}`;
  useEffect(() => {
    if (isEdit) {
      setDraftChecked(true);
      return;
    }
    const candidate = readDraft(draftKey);
    const hasContent = Boolean(candidate && (candidate.title.trim() || candidate.phenomenon || candidate.rootCause || candidate.solution || candidate.attachments.length));
    setDraftCandidate(hasContent ? candidate : null);
    setDraftChecked(true);
  }, [isEdit, draftKey]);

  useEffect(() => {
    if (isEdit || !draftChecked || draftCandidate) return;
    const hasContent = Boolean(title.trim() || phenomenon || rootCause || solution || attachments.length);
    if (!hasContent) {
      try {
        window.sessionStorage.removeItem(draftKey);
      } catch {
        /* Best effort. */
      }
      return;
    }
    const handle = window.setTimeout(() => {
      try {
        window.sessionStorage.setItem(draftKey, JSON.stringify({
          title,
          protocol,
          tags,
          phenomenon,
          rootCause,
          solution,
          attachments,
          savedAt: new Date().toISOString(),
        } satisfies DraftPayload));
      } catch {
        /* sessionStorage may be unavailable; autosave is best-effort. */
      }
    }, 800);
    return () => window.clearTimeout(handle);
  }, [isEdit, draftChecked, draftCandidate, draftKey, title, protocol, tags, phenomenon, rootCause, solution, attachments]);

  const restoreDraft = () => {
    if (!draftCandidate) return;
    setTitle(draftCandidate.title);
    setProtocol(draftCandidate.protocol);
    setTags(draftCandidate.tags);
    setPhenomenon(draftCandidate.phenomenon);
    setRootCause(draftCandidate.rootCause);
    setSolution(draftCandidate.solution);
    setAttachments(draftCandidate.attachments);
    setDirty(true);
    setDraftCandidate(null);
  };

  const discardDraft = () => {
    try {
      window.sessionStorage.removeItem(draftKey);
    } catch {
      /* Best effort. */
    }
    setDraftCandidate(null);
  };

  const unsavedChanges = useUnsavedChangesGuard(dirty, () => setDirty(false));

  const protocols = useMemo(() => (meta?.protocols?.length ? meta.protocols : ['General']), [meta]);
  const maxFileBytes = meta?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxAttachments = meta?.maxAttachments ?? 10;

  const handleUploadFiles = async (files: FileList | File[]) => {
    if (uploading) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setError(null);
    const slots = Math.max(0, maxAttachments - attachments.length);
    if (slots === 0) {
      setError(t('kb_attachment_limit', { max: maxAttachments }));
      return;
    }
    const selected = list.slice(0, slots);
    if (list.length > slots) setError(t('kb_attachment_limit', { max: maxAttachments }));
    setUploading(true);
    try {
      for (const file of selected) {
        if (file.size > maxFileBytes) {
          setError(t('kb_file_too_large', { size: formatFileSize(maxFileBytes) }));
          continue;
        }
        try {
          const uploaded = await uploadKnowledgeFile(file);
          setAttachments((prev) => [...prev, { ...uploaded }]);
          setDirty(true);
        } catch (err) {
          setError(knowledgeErrorMessage(err, t, 'kb_upload_failed'));
        }
      }
    } finally {
      setUploading(false);
    }
  };

  const handleAttachmentDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer.files?.length) void handleUploadFiles(event.dataTransfer.files);
  };

  const handleInlineImage = async (file: File): Promise<{ url: string; name: string } | null> => {
    if (uploading) return null;
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
        window.sessionStorage.removeItem(draftKey);
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
      if (isEdit && entryId && err instanceof MutationApiError && err.code === 'KNOWLEDGE_REVISION_CONFLICT') {
        setError(null);
        try {
          const latest = await fetchEntry(entryId);
          setConflict(latest);
        } catch {
          setError(knowledgeErrorMessage(err, t));
        } finally {
          setSaving(false);
        }
        return;
      }
      setError(knowledgeErrorMessage(err, t));
      setSaving(false);
    }
  };

  const copyConflictDraft = async () => {
    if (!navigator.clipboard) {
      setError(t('kb_copy_failed'));
      return;
    }
    const text = [
      `${t('kb_field_title')}: ${title}`,
      `${t('kb_field_phenomenon')}:\n${phenomenon}`,
      `${t('kb_field_root_cause')}:\n${rootCause}`,
      `${t('kb_field_solution')}:\n${solution}`,
      `${t('kb_field_tags')}: ${tags.join(', ')}`,
    ].join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setConflictNotice(t('kb_conflict_copied'));
    } catch {
      setError(t('kb_copy_failed'));
    }
  };

  const reloadConflict = async () => {
    if (!entryId) return;
    setConflictReloading(true);
    try {
      const latest = await fetchEntry(entryId);
      applyEntry(latest);
      setDirty(false);
      setConflict(null);
      setError(null);
      setConflictNotice(t('kb_conflict_reloaded'));
    } catch (err) {
      setError(knowledgeReadErrorMessage(err, t, 'kb_error_body'));
    } finally {
      setConflictReloading(false);
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
      {conflictNotice && <OperationNotice tone="success" message={conflictNotice} onClose={() => setConflictNotice(null)} />}
      {draftCandidate && !isEdit && (
        <ConfirmActionPanel
          presentation="inline"
          tone="info"
          title={t('kb_draft_found_title')}
          message={t('kb_draft_found_message')}
          confirmLabel={t('kb_draft_restore')}
          cancelLabel={t('kb_draft_discard')}
          onConfirm={restoreDraft}
          onCancel={discardDraft}
        />
      )}

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
              <label className={styles.fieldLabel} htmlFor="kb-entry-phenomenon">{t('kb_field_phenomenon')}</label>
              <MarkdownEditor
                id="kb-entry-phenomenon"
                describedBy="kb-phenomenon-count"
                value={phenomenon}
                onChange={(value) => markDirty(() => setPhenomenon(value))}
                placeholder={t('kb_phenomenon_placeholder')}
                ariaLabel={t('kb_field_phenomenon')}
              />
              <span id="kb-phenomenon-count" className={styles.charCount}>
                {t('kb_char_count', { count: phenomenon.length, max: TEXT_MAX })}
              </span>
            </section>

            <section className={styles.card} data-tone="warning">
              <label className={styles.fieldLabel} htmlFor="kb-entry-root-cause">{t('kb_field_root_cause')}</label>
              <MarkdownEditor
                id="kb-entry-root-cause"
                describedBy="kb-root-cause-count"
                value={rootCause}
                onChange={(value) => markDirty(() => setRootCause(value))}
                placeholder={t('kb_root_cause_placeholder')}
                ariaLabel={t('kb_field_root_cause')}
              />
              <span id="kb-root-cause-count" className={styles.charCount}>
                {t('kb_char_count', { count: rootCause.length, max: TEXT_MAX })}
              </span>
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
                      multiple
                      className={styles.hiddenInput}
                      disabled={uploading}
                      onChange={(event) => {
                        const files = event.target.files;
                        event.target.value = '';
                        if (files?.length) void handleUploadFiles(files);
                      }}
                    />
                  </label>
                </div>
                <div
                  className={`${styles.attachDrop} ${dragActive ? styles.attachDropActive : ''}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragActive(true);
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleAttachmentDrop}
                >
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
                  <p className={styles.attachHint}>{t('kb_attachment_drop')} {t('kb_attachment_hint', { size: formatFileSize(maxFileBytes) })}</p>
                </div>
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

      {conflict && (
        <ConfirmActionPanel
          presentation="modal"
          tone="warning"
          title={t('kb_conflict_title')}
          message={t('kb_conflict_message', { serverRevision: conflict.revision, localRevision: revision })}
          confirmLabel={t('kb_conflict_reload')}
          cancelLabel={t('kb_conflict_keep')}
          isWorking={conflictReloading}
          onConfirm={() => void reloadConflict()}
          onCancel={() => { if (!conflictReloading) setConflict(null); }}
        >
          <button type="button" className={styles.secondaryButton} onClick={() => void copyConflictDraft()}>
            {t('kb_conflict_copy')}
          </button>
        </ConfirmActionPanel>
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
