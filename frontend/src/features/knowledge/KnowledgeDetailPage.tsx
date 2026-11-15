import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useSWRConfig } from 'swr';
import { Activity, ArrowLeft, Copy, Download, Edit, Eye, FileText, Trash2, TriangleAlert, X } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import { ConfirmActionPanel, EmptyState, OperationNotice } from '../../components/ui/OperationFeedback';
import { getBlob } from '../../lib/api/read-client';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import { copyText } from '../../lib/clipboard';
import { resolveReturnTo, withReturnTo } from '../../lib/return-to';
import { MarkdownContent } from './components/MarkdownContent';
import { attachmentUrl, deleteEntry, entryExportUrl, isKnowledgeListKey, restoreEntry, restoreVersion } from './knowledge-api';
import { knowledgeErrorMessage, knowledgeReadErrorMessage } from './knowledge-errors';
import { fileKindLabel, formatFileSize, isImage } from './knowledge-format';
import type { Attachment, EntryVersionSummary, KnowledgeEntry } from './types';
import styles from '../../styles/modules/knowledge.module.css';

export function KnowledgeDetailPage() {
  const { entryId } = useParams<{ entryId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const { mutate } = useSWRConfig();
  const canConfigure = hasPermission(user, 'core.configure');
  const listReturnTo = resolveReturnTo(location.search, '/knowledge', ['/knowledge']);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(
    Boolean((location.state as { knowledgeSaved?: boolean } | null)?.knowledgeSaved),
  );
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreVersionTarget, setRestoreVersionTarget] = useState<EntryVersionSummary | null>(null);
  const copyTimer = useRef<number | null>(null);
  const [preview, setPreview] = useState<{ name: string; kind: string; url: string; text: string | null } | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const { data, error, isLoading, mutate: retryRead } = useRead<KnowledgeEntry>(entryId ? `/api/knowledge/entries/${entryId}` : null);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    if (previewUrlRef.current !== null) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const releasePreviewUrl = () => {
    if (previewUrlRef.current !== null) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  };

  const openPreview = async (file: Attachment) => {
    releasePreviewUrl();
    setPreview(null);
    setActionError(null);
    try {
      const blob = await getBlob(attachmentUrl(file.fileId));
      if (file.kind === 'text') {
        setPreview({ name: file.originalName, kind: file.kind, url: '', text: await blob.text() });
      } else {
        const url = URL.createObjectURL(blob);
        previewUrlRef.current = url;
        setPreview({ name: file.originalName, kind: file.kind, url, text: null });
      }
    } catch {
      setActionError(t('kb_error_body'));
    }
  };

  const closePreview = () => {
    releasePreviewUrl();
    setPreview(null);
  };

  useEffect(() => {
    if (savedNotice) navigate(location.pathname, { replace: true, state: null });
  }, [savedNotice, navigate, location.pathname]);

  const confirmDelete = async (permanent: boolean) => {
    if (!data) return;
    setDeleting(true);
    setActionError(null);
    try {
      await deleteEntry(data.id, data.revision, permanent);
      // Revalidate the cached list before returning so the deleted row cannot
      // reappear from SWR's dedupe window.
      try {
        await mutate(isKnowledgeListKey, undefined, { revalidate: true });
        await mutate(`/api/knowledge/entries/${data.id}`, undefined, { revalidate: true });
        await mutate('/api/knowledge/meta');
      } catch {
        /* Reads still revalidate when they mount. */
      }
      setDeleting(false);
      setDeleteOpen(false);
      setPurgeOpen(false);
      // Return to the originating list view so filters, sort and the cursor
      // back-stack survive the delete. A direct detail link falls back to the
      // recycle bin after a permanent delete.
      const destination = listReturnTo !== '/knowledge'
        ? listReturnTo
        : permanent
          ? '/knowledge?status=deleted'
          : '/knowledge';
      navigate(destination);
    } catch (err) {
      setDeleting(false);
      setDeleteOpen(false);
      setActionError(knowledgeErrorMessage(err, t, 'kb_delete_failed'));
    }
  };

  const confirmRestore = async () => {
    if (!data) return;
    setRestoring(true);
    setActionError(null);
    try {
      await restoreEntry(data.id, data.revision);
      try {
        await mutate(isKnowledgeListKey, undefined, { revalidate: true });
        await mutate(`/api/knowledge/entries/${data.id}`, undefined, { revalidate: true });
        await mutate('/api/knowledge/meta');
      } catch {
        /* Reads still revalidate when they mount. */
      }
      setRestoring(false);
      setRestoreOpen(false);
      setSuccessNotice(t('kb_restore_success'));
    } catch (err) {
      setRestoring(false);
      setActionError(knowledgeErrorMessage(err, t, 'kb_restore_failed'));
    }
  };

  const confirmRestoreVersion = async (version: EntryVersionSummary) => {
    if (!data) return;
    setRestoringVersion(version.versionId);
    setActionError(null);
    try {
      await restoreVersion(data.id, version.versionId, data.revision);
      try {
        await mutate(isKnowledgeListKey, undefined, { revalidate: true });
        await mutate(`/api/knowledge/entries/${data.id}`, undefined, { revalidate: true });
        await mutate('/api/knowledge/meta');
      } catch {
        /* Reads still revalidate when they mount. */
      }
      setRestoringVersion(null);
      setRestoreVersionTarget(null);
      setSuccessNotice(t('kb_restore_version_success'));
    } catch (err) {
      setRestoringVersion(null);
      setActionError(knowledgeErrorMessage(err, t, 'kb_restore_failed'));
    }
  };

  const flashCopyState = (next: 'copied' | 'failed') => {
    setCopyState(next);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 2000);
  };

  const copySolution = async () => {
    if (!data) return;
    flashCopyState((await copyText(data.solution ?? '')) ? 'copied' : 'failed');
  };

  if (isLoading) {
    return <div className="container animate-fade-in"><EmptyState icon={<FileText size={40} />} title={t('loading')} /></div>;
  }
  if (error || !data) {
    return (
      <div className="container animate-fade-in">
        <EmptyState
          icon={<FileText size={40} />}
          title={t('kb_error_title')}
          description={knowledgeReadErrorMessage(error, t, 'kb_error_body')}
          action={(
            <button type="button" className={styles.secondaryButton} onClick={() => void retryRead()}>
              {t('kb_retry')}
            </button>
          )}
        />
      </div>
    );
  }

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={data.protocol || t('kb_protocol_general')}
        icon={<FileText size={24} />}
        title={data.title}
        actions={
          <div className={styles.headerActions}>
            <Link to={listReturnTo} className={styles.backButton}><ArrowLeft size={15} /> {t('kb_back')}</Link>
            <a href={entryExportUrl(data.id)} className={styles.secondaryButton} download>
              <Download size={15} /> {t('kb_export')}
            </a>
            {canConfigure && data.status === 'deleted' && (
              <>
                <button type="button" className={styles.secondaryButton} onClick={() => setRestoreOpen(true)} disabled={restoring}>
                  <Edit size={15} /> {restoring ? t('saving') : t('kb_restore')}
                </button>
                <button type="button" className={styles.dangerButton} onClick={() => setPurgeOpen(true)}>
                  <Trash2 size={15} /> {t('kb_permanent_delete')}
                </button>
              </>
            )}
            {canConfigure && data.status !== 'deleted' && (
              <>
                <Link to={withReturnTo(`/knowledge/${data.id}/edit`, listReturnTo)} className={styles.secondaryButton}><Edit size={15} /> {t('edit')}</Link>
                <button type="button" className={styles.dangerButton} onClick={() => setDeleteOpen(true)}>
                  <Trash2 size={15} /> {t('delete')}
                </button>
              </>
            )}
          </div>
        }
      />

      {savedNotice && (
        <OperationNotice tone="success" message={t('kb_save_success')} onClose={() => setSavedNotice(false)} />
      )}
      {successNotice && (
        <OperationNotice tone="success" message={successNotice} onClose={() => setSuccessNotice(null)} />
      )}
      {actionError && (
        <OperationNotice tone="danger" message={actionError} onClose={() => setActionError(null)} />
      )}
      {data.status === 'deleted' && (
        <OperationNotice tone="warning" message={t('kb_deleted_banner')} />
      )}

      <div className={styles.detailMeta}>
        <span>{t('kb_detail_created', { time: formatDateTime(data.createdAt), by: data.createdBy || '—' })}</span>
        <span aria-hidden="true">·</span>
        <span>{t('kb_detail_updated', { time: formatDateTime(data.updatedAt), by: data.updatedBy || '—' })}</span>
      </div>

      {data.tags.length > 0 && (
        <div className={styles.tagStrip}>
          {data.tags.map((tag) => (
            <Link key={tag} to={`/knowledge?tag=${encodeURIComponent(tag)}`} className={styles.tagChip}>
              {tag}
            </Link>
          ))}
        </div>
      )}

      <div className={styles.grid2}>
        <section className={styles.card} data-tone="danger">
          <h2 className={styles.cardTitle}><TriangleAlert size={15} /> {t('kb_phenomenon')}</h2>
          <p className={styles.cardBody}>{data.phenomenon || t('kb_no_phenomenon')}</p>
        </section>
        <section className={styles.card} data-tone="warning">
          <h2 className={styles.cardTitle}><Activity size={15} /> {t('kb_root_cause')}</h2>
          {data.rootCause ? (
            <MarkdownContent content={data.rootCause} />
          ) : (
            <p className={styles.cardBody}>{t('kb_no_root_cause')}</p>
          )}
        </section>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t('kb_solution')}</h2>
          <button type="button" className={styles.copyButton} onClick={copySolution} aria-live="polite">
            <Copy size={14} /> {copyState === 'copied' ? t('kb_copy_done') : copyState === 'failed' ? t('kb_copy_failed') : t('kb_copy')}
          </button>
        </div>
        <MarkdownContent content={data.solution ?? ''} />
      </section>

      {data.attachments.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}><FileText size={15} /> {t('kb_attachments')}</h2>
          <div className={styles.attachmentGrid}>
            {data.attachments.map((file) => (
              <div key={file.fileId} className={styles.attachmentItem}>
                {isImage(file.kind) ? (
                  <a href={attachmentUrl(file.fileId)} target="_blank" rel="noreferrer">
                    <img src={attachmentUrl(file.fileId)} alt={file.originalName} className={styles.attachmentThumb} />
                  </a>
                ) : (
                  <div className={styles.attachmentIcon}>{fileKindLabel(file.kind)}</div>
                )}
                <div className={styles.attachmentInfo}>
                  <span className={styles.attachmentName} title={file.originalName}>{file.originalName}</span>
                  <span className={styles.attachmentSize}>{formatFileSize(file.size)}</span>
                </div>
                {(file.kind === 'pdf' || file.kind === 'text') && (
                  <button type="button" className={styles.attachmentDownload} onClick={() => void openPreview(file)} aria-label={t('kb_preview')}>
                    <Eye size={15} />
                  </button>
                )}
                <a href={`${attachmentUrl(file.fileId)}?download=1`} className={styles.attachmentDownload} aria-label={t('kb_download')}>
                  <Download size={15} />
                </a>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.status !== 'deleted' && (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}><FileText size={15} /> {t('kb_versions')}</h2>
          {!data.versions || data.versions.length === 0 ? (
            <p className={styles.cardBody}>{t('kb_no_versions')}</p>
          ) : (
            <ul className={styles.attachList}>
              {data.versions.map((version) => (
                <li key={version.versionId} className={styles.attachItem}>
                  <span className={styles.attachName}>
                    {t('kb_version_at', { revision: version.revision, time: formatDateTime(version.createdAt), by: version.createdBy || '—' })}
                  </span>
                  {canConfigure && (
                    <button
                      type="button"
                      className={styles.copyButton}
                      disabled={restoringVersion !== null}
                      onClick={() => setRestoreVersionTarget(version)}
                    >
                      {restoringVersion === version.versionId ? t('saving') : t('kb_restore_version')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {data.referencedBy && data.referencedBy.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}><Activity size={15} /> {t('kb_referenced_by')}</h2>
          <p className={styles.cardBody}>{t('kb_reference_count', { count: data.referenceCount ?? data.referencedBy.length })}</p>
          {(data.referenceCount ?? data.referencedBy.length) > data.referencedBy.length && (
            <p className={styles.referenceNote}>
              {t('kb_reference_truncated', { shown: data.referencedBy.length, count: data.referenceCount ?? data.referencedBy.length })}
            </p>
          )}
          <ul className={styles.attachList}>
            {data.referencedBy.map((ref) => (
              <li key={ref.investigationId} className={styles.attachItem}>
                <Link to={`/investigations/${ref.investigationId}`} className={styles.attachName}>
                  {ref.title || ref.investigationId}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {preview && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}><FileText size={15} /> {preview.name}</h2>
            <button type="button" className={styles.copyButton} onClick={closePreview}>
              <X size={14} /> {t('cancel')}
            </button>
          </div>
          {preview.kind === 'text' ? (
            <pre className={styles.textPreview}>{preview.text}</pre>
          ) : (
            <iframe src={preview.url} title={preview.name} className={styles.pdfPreview} />
          )}
        </section>
      )}

      {deleteOpen && (
        <ConfirmActionPanel
          presentation="modal"
          tone="danger"
          title={t('delete')}
          message={t('kb_delete_confirm_impact', {
            refs: data.referenceCount ?? data.referencedBy?.length ?? 0,
            attachments: data.attachments.length,
          })}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          isWorking={deleting}
          onConfirm={() => void confirmDelete(false)}
          onCancel={() => { if (!deleting) setDeleteOpen(false); }}
        />
      )}

      {purgeOpen && (
        <ConfirmActionPanel
          presentation="modal"
          tone="danger"
          title={t('kb_permanent_delete')}
          message={t('kb_permanent_delete_confirm_impact', {
            refs: data.referenceCount ?? data.referencedBy?.length ?? 0,
            attachments: data.attachments.length,
          })}
          confirmLabel={t('kb_permanent_delete')}
          cancelLabel={t('cancel')}
          isWorking={deleting}
          onConfirm={() => void confirmDelete(true)}
          onCancel={() => { if (!deleting) setPurgeOpen(false); }}
        />
      )}
      {restoreOpen && (
        <ConfirmActionPanel
          presentation="modal"
          tone="info"
          title={t('kb_restore')}
          message={t('kb_restore_confirm')}
          confirmLabel={t('kb_restore')}
          cancelLabel={t('cancel')}
          isWorking={restoring}
          onConfirm={() => void confirmRestore()}
          onCancel={() => { if (!restoring) setRestoreOpen(false); }}
        />
      )}

      {restoreVersionTarget && (
        <ConfirmActionPanel
          presentation="modal"
          tone="info"
          title={t('kb_restore_version')}
          message={t('kb_version_restore_confirm', { revision: restoreVersionTarget.revision })}
          confirmLabel={t('kb_restore_version')}
          cancelLabel={t('cancel')}
          isWorking={restoringVersion !== null}
          onConfirm={() => void confirmRestoreVersion(restoreVersionTarget)}
          onCancel={() => { if (restoringVersion === null) setRestoreVersionTarget(null); }}
        />
      )}
    </div>
  );
}
