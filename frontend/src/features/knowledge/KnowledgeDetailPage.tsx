import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useSWRConfig } from 'swr';
import { Activity, ArrowLeft, Copy, Download, Edit, Eye, FileText, GitCompare, Link2, Printer, Trash2, TriangleAlert, X, ZoomIn, ZoomOut } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import { ConfirmActionPanel, EmptyState, OperationNotice } from '../../components/ui/OperationFeedback';
import { Dialog } from '../../components/ui/Dialog';
import { getBlob } from '../../lib/api/read-client';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import { copyText } from '../../lib/clipboard';
import { resolveReturnTo, withReturnTo } from '../../lib/return-to';
import { MarkdownContent } from './components/MarkdownContent';
import { attachmentUrl, deleteEntry, entryExportUrl, fetchEntryVersion, isKnowledgeListKey, restoreEntry, restoreVersion } from './knowledge-api';
import { knowledgeErrorMessage, knowledgeReadErrorMessage } from './knowledge-errors';
import { fileKindLabel, formatFileSize, isImage } from './knowledge-format';
import { diffLines } from './knowledge-diff';
import type { Attachment, EntryVersion, EntryVersionSummary, FileKind, KnowledgeEntry } from './types';
import styles from '../../styles/modules/knowledge.module.css';

const OPERATION_KEYS: Record<string, string> = {
  'knowledge.entry.create': 'kb_op_create',
  'knowledge.entry.update': 'kb_op_update',
  'knowledge.entry.delete': 'kb_op_delete',
  'knowledge.entry.restore': 'kb_op_restore',
  'knowledge.entry.purge': 'kb_op_purge',
  'knowledge.file.attach': 'kb_op_file_attach',
  'knowledge.file.detach': 'kb_op_file_detach',
};

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
  const [preview, setPreview] = useState<{ fileId: string; name: string; kind: FileKind; url: string; text: string | null } | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [versionView, setVersionView] = useState<{ version: EntryVersionSummary; content: EntryVersion; mode: 'preview' | 'diff' } | null>(null);
  const [versionLoading, setVersionLoading] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

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
    setPreviewZoom(1);
    setActionError(null);
    try {
      const blob = await getBlob(attachmentUrl(file.fileId));
      if (file.kind === 'text') {
        setPreview({ fileId: file.fileId, name: file.originalName, kind: file.kind, url: '', text: await blob.text() });
      } else {
        const url = URL.createObjectURL(blob);
        previewUrlRef.current = url;
        setPreview({ fileId: file.fileId, name: file.originalName, kind: file.kind, url, text: null });
      }
    } catch {
      setActionError(t('kb_error_body'));
    }
  };

  const closePreview = () => {
    releasePreviewUrl();
    setPreview(null);
    setPreviewZoom(1);
  };

  const copyEntryLink = async () => {
    const copied = await copyText(window.location.href);
    setLinkCopied(copied);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setLinkCopied(false), 2000);
  };

  const openVersion = async (version: EntryVersionSummary, mode: 'preview' | 'diff') => {
    if (!data) return;
    setVersionError(null);
    if (versionView?.version.versionId === version.versionId) {
      setVersionView({ ...versionView, mode });
      return;
    }
    setVersionLoading(version.versionId);
    try {
      const content = await fetchEntryVersion(data.id, version.versionId);
      setVersionView({ version, content, mode });
    } catch (err) {
      setVersionError(knowledgeReadErrorMessage(err, t, 'kb_error_body'));
    } finally {
      setVersionLoading(null);
    }
  };

  const closeVersion = () => {
    setVersionView(null);
    setVersionError(null);
  };

  const renderDiff = (label: string, current: string, previous: string) => {
    const diff = diffLines(current, previous);
    return (
      <div className={styles.diffGroup}>
        <h3 className={styles.diffTitle}>
          {label}
          <span className={styles.diffStats}>+{diff.added} / -{diff.removed}</span>
        </h3>
        {diff.lines.length === 0 ? (
          <p className={styles.cardBody}>{t('kb_diff_no_changes')}</p>
        ) : (
          <div className={styles.diffBody}>
            {diff.lines.map((line, index) => (
              <div
                key={`${label}-${index}`}
                className={`${styles.diffLine} ${line.type === 'added' ? styles.diffAdded : line.type === 'removed' ? styles.diffRemoved : styles.diffSame}`}
              >
                {line.text || ' '}
              </div>
            ))}
          </div>
        )}
        {diff.truncated && <p className={styles.referenceNote}>{t('kb_diff_truncated')}</p>}
      </div>
    );
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
            <button type="button" className={styles.secondaryButton} onClick={() => void copyEntryLink()}>
              <Link2 size={15} /> {linkCopied ? t('kb_link_copied') : t('kb_copy_link')}
            </button>
            <button type="button" className={styles.secondaryButton} onClick={() => window.print()}>
              <Printer size={15} /> {t('kb_print')}
            </button>
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
          {data.phenomenon ? <MarkdownContent content={data.phenomenon} /> : <p className={styles.cardBody}>{t('kb_no_phenomenon')}</p>}
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
                {(isImage(file.kind) || file.kind === 'pdf' || file.kind === 'text') && (
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
                  <div className={styles.versionActions}>
                    <button
                      type="button"
                      className={styles.copyButton}
                      disabled={versionLoading !== null}
                      onClick={() => void openVersion(version, 'preview')}
                    >
                      <Eye size={14} /> {versionLoading === version.versionId ? t('loading') : t('kb_version_preview')}
                    </button>
                    <button
                      type="button"
                      className={styles.copyButton}
                      disabled={versionLoading !== null}
                      onClick={() => void openVersion(version, 'diff')}
                    >
                      <GitCompare size={14} /> {t('kb_version_diff')}
                    </button>
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
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className={styles.card}>
        <h2 className={styles.cardTitle}><Activity size={15} /> {t('kb_operations')}</h2>
        {!data.operationsComplete ? (
          <p className={styles.cardBody}>{t('kb_operations_unavailable')}</p>
        ) : !data.operations || data.operations.length === 0 ? (
          <p className={styles.cardBody}>{t('kb_no_operations')}</p>
        ) : (
          <ul className={styles.operationList}>
            {data.operations.map((operation) => {
              const label = t(OPERATION_KEYS[operation.action] ?? 'kb_operation_unknown');
              const revisions = operation.beforeRevision || operation.afterRevision
                ? `r${operation.beforeRevision || '—'} → r${operation.afterRevision || '—'}`
                : '';
              return (
                <li key={operation.id} className={styles.operationItem}>
                  <div className={styles.operationHead}>
                    <strong>{label}</strong>
                    <span>{formatDateTime(operation.timestamp)}</span>
                  </div>
                  <div className={styles.operationMeta}>
                    {operation.actor || '—'}
                    {operation.role ? ` · ${operation.role}` : ''}
                    {operation.result ? ` · ${operation.result}` : ''}
                    {revisions ? ` · ${revisions}` : ''}
                  </div>
                  {operation.reason && <p className={styles.operationReason}>{operation.reason}</p>}
                  {operation.files && operation.files.length > 0 && (
                    <p className={styles.operationReason}>{t('kb_op_files', { files: operation.files.join(', ') })}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

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
        <Dialog
          open
          onClose={closePreview}
          overlayClassName="op-modal-backdrop-darker"
          className={`op-modal-dialog-shell ${styles.previewDialog}`}
          labelledBy="kb-preview-title"
          role="dialog"
        >
          <div className={styles.dialogHead}>
            <h2 id="kb-preview-title" className={styles.cardTitle}><FileText size={15} /> {preview.name}</h2>
            <div className={styles.previewActions}>
              {isImage(preview.kind) && (
                <>
                  <button type="button" className={styles.attachmentDownload} aria-label={t('kb_zoom_out')} onClick={() => setPreviewZoom((value) => Math.max(0.5, value - 0.25))}>
                    <ZoomOut size={15} />
                  </button>
                  <span className={styles.previewZoom}>{Math.round(previewZoom * 100)}%</span>
                  <button type="button" className={styles.attachmentDownload} aria-label={t('kb_zoom_in')} onClick={() => setPreviewZoom((value) => Math.min(3, value + 0.25))}>
                    <ZoomIn size={15} />
                  </button>
                </>
              )}
              <a href={`${attachmentUrl(preview.fileId)}?download=1`} className={styles.attachmentDownload} aria-label={t('kb_download')}>
                <Download size={15} />
              </a>
              <button type="button" className={styles.attachmentDownload} aria-label={t('close')} onClick={closePreview}>
                <X size={15} />
              </button>
            </div>
          </div>
          {preview.kind === 'text' ? (
            <pre className={styles.textPreview}>{preview.text}</pre>
          ) : isImage(preview.kind) ? (
            <div className={styles.previewImageWrap}>
              <img
                src={preview.url}
                alt={preview.name}
                className={styles.previewImage}
                style={{ transform: `scale(${previewZoom})` }}
              />
            </div>
          ) : (
            <iframe src={preview.url} title={preview.name} className={styles.pdfPreview} />
          )}
        </Dialog>
      )}

      {versionError && <OperationNotice tone="danger" message={versionError} onClose={() => setVersionError(null)} />}

      {versionView && (
        <Dialog
          open
          onClose={closeVersion}
          overlayClassName="op-modal-backdrop-darker"
          className={`op-modal-dialog-shell ${styles.versionDialog}`}
          labelledBy="kb-version-dialog-title"
          role="dialog"
        >
          <div className={styles.dialogHead}>
            <h2 id="kb-version-dialog-title" className={styles.cardTitle}>
              {t('kb_version_preview_title', { revision: versionView.version.revision })}
            </h2>
            <button type="button" className={styles.attachmentDownload} aria-label={t('close')} onClick={closeVersion}>
              <X size={15} />
            </button>
          </div>
          <div className={styles.versionTabs} role="group" aria-label={t('kb_versions')}>
            <button
              type="button"
              className={`${styles.versionTab} ${versionView.mode === 'preview' ? styles.versionTabActive : ''}`}
              aria-pressed={versionView.mode === 'preview'}
              onClick={() => setVersionView({ ...versionView, mode: 'preview' })}
            >
              {t('kb_version_preview')}
            </button>
            <button
              type="button"
              className={`${styles.versionTab} ${versionView.mode === 'diff' ? styles.versionTabActive : ''}`}
              aria-pressed={versionView.mode === 'diff'}
              onClick={() => setVersionView({ ...versionView, mode: 'diff' })}
            >
              {t('kb_version_diff')}
            </button>
          </div>
          {versionView.mode === 'preview' ? (
            <div className={styles.versionContent}>
              <h3>{versionView.content.title}</h3>
              <p className={styles.panelMeta}>
                {versionView.content.protocol || t('kb_protocol_general')} · {formatDateTime(versionView.content.createdAt)} · {versionView.content.createdBy || '—'}
              </p>
              <h3>{t('kb_phenomenon')}</h3>
              {versionView.content.phenomenon ? <MarkdownContent content={versionView.content.phenomenon} /> : <p>{t('kb_no_phenomenon')}</p>}
              <h3>{t('kb_root_cause')}</h3>
              {versionView.content.rootCause ? <MarkdownContent content={versionView.content.rootCause} /> : <p>{t('kb_no_root_cause')}</p>}
              <h3>{t('kb_solution')}</h3>
              <MarkdownContent content={versionView.content.solution ?? ''} />
            </div>
          ) : (
            <div className={styles.versionContent}>
              {renderDiff(t('kb_field_title'), data.title, versionView.content.title)}
              {renderDiff(t('kb_field_phenomenon'), data.phenomenon, versionView.content.phenomenon)}
              {renderDiff(t('kb_field_root_cause'), data.rootCause, versionView.content.rootCause)}
              {renderDiff(t('kb_field_solution'), data.solution, versionView.content.solution)}
            </div>
          )}
        </Dialog>
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
