import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useSWRConfig } from 'swr';
import { Activity, ArrowLeft, Copy, Download, Edit, FileText, Trash2, TriangleAlert } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import { ConfirmActionPanel, EmptyState, OperationNotice } from '../../components/ui/OperationFeedback';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import { MarkdownContent } from './components/MarkdownContent';
import { attachmentUrl, deleteEntry, isKnowledgeListKey } from './knowledge-api';
import { knowledgeErrorMessage } from './knowledge-errors';
import { fileKindLabel, formatFileSize, isImage } from './knowledge-format';
import type { KnowledgeEntry } from './types';
import styles from '../../styles/modules/knowledge.module.css';

/** Copy without the Clipboard API, which is unavailable on plain-HTTP origins. */
function copyWithSelection(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) throw new Error('copy failed');
}

export function KnowledgeDetailPage() {
  const { entryId } = useParams<{ entryId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const { mutate } = useSWRConfig();
  const canConfigure = hasPermission(user, 'core.configure');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(
    Boolean((location.state as { knowledgeSaved?: boolean } | null)?.knowledgeSaved),
  );
  const copyTimer = useRef<number | null>(null);

  const { data, error, isLoading } = useRead<KnowledgeEntry>(entryId ? `/api/knowledge/entries/${entryId}` : null);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  useEffect(() => {
    if (savedNotice) navigate(location.pathname, { replace: true, state: null });
  }, [savedNotice, navigate, location.pathname]);

  const confirmDelete = async () => {
    if (!data) return;
    setDeleting(true);
    setActionError(null);
    try {
      await deleteEntry(data.id, data.revision);
      // Revalidate the cached list before returning so the deleted row cannot
      // reappear from SWR's dedupe window.
      try {
        await mutate(isKnowledgeListKey, undefined, { revalidate: true });
      } catch {
        /* The list still revalidates when it mounts. */
      }
      navigate('/knowledge');
    } catch (err) {
      setDeleting(false);
      setDeleteOpen(false);
      setActionError(knowledgeErrorMessage(err, t, 'kb_delete_failed'));
    }
  };

  const flashCopyState = (next: 'copied' | 'failed') => {
    setCopyState(next);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 2000);
  };

  const copySolution = async () => {
    if (!data) return;
    const text = data.solution ?? '';
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        copyWithSelection(text);
      }
      flashCopyState('copied');
    } catch {
      try {
        copyWithSelection(text);
        flashCopyState('copied');
      } catch {
        flashCopyState('failed');
      }
    }
  };

  if (isLoading) {
    return <div className="container animate-fade-in"><EmptyState icon={<FileText size={40} />} title={t('loading')} /></div>;
  }
  if (error || !data) {
    return <div className="container animate-fade-in"><EmptyState icon={<FileText size={40} />} title={t('kb_error_title')} description={t('kb_error_body')} /></div>;
  }

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={data.protocol || t('kb_protocol_general')}
        icon={<FileText size={24} />}
        title={data.title}
        actions={
          <div className={styles.headerActions}>
            <Link to="/knowledge" className={styles.backButton}><ArrowLeft size={15} /> {t('kb_back')}</Link>
            {canConfigure && (
              <>
                <Link to={`/knowledge/${data.id}/edit`} className={styles.secondaryButton}><Edit size={15} /> {t('edit')}</Link>
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
      {actionError && (
        <OperationNotice tone="danger" message={actionError} onClose={() => setActionError(null)} />
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
          <p className={styles.cardBody}>{data.rootCause || t('kb_no_root_cause')}</p>
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
                <a href={`${attachmentUrl(file.fileId)}?download=1`} className={styles.attachmentDownload} aria-label={t('kb_download')}>
                  <Download size={15} />
                </a>
              </div>
            ))}
          </div>
        </section>
      )}

      {deleteOpen && (
        <ConfirmActionPanel
          presentation="modal"
          tone="danger"
          title={t('delete')}
          message={t('kb_delete_confirm')}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          isWorking={deleting}
          onConfirm={confirmDelete}
          onCancel={() => { if (!deleting) setDeleteOpen(false); }}
        />
      )}
    </div>
  );
}
