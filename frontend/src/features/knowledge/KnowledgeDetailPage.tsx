import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Copy, Download, Edit, FileText, Trash2, TriangleAlert } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/OperationFeedback';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import { MarkdownContent } from './components/MarkdownContent';
import { attachmentUrl, deleteEntry } from './knowledge-api';
import { fileKindLabel, formatFileSize, isImage } from './knowledge-format';
import type { KnowledgeEntry } from './types';
import styles from '../../styles/modules/knowledge.module.css';

export function KnowledgeDetailPage() {
  const { entryId } = useParams<{ entryId: string }>();
  const navigate = useNavigate();
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const canConfigure = hasPermission(user, 'core.configure');
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { data, error, isLoading } = useRead<KnowledgeEntry>(entryId ? `/api/knowledge/entries/${entryId}` : null);

  const handleDelete = async () => {
    if (!data || !window.confirm(t('kb_delete_confirm'))) return;
    setDeleting(true);
    try {
      await deleteEntry(data.id, data.revision);
      navigate('/knowledge');
    } catch {
      setDeleting(false);
    }
  };

  const copySolution = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.solution ?? '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
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
        description={t('kb_detail_updated', { time: formatDateTime(data.updatedAt), by: data.updatedBy })}
        actions={
          <div className={styles.headerActions}>
            <Link to="/knowledge" className={styles.backButton}><ArrowLeft size={15} /> {t('kb_back')}</Link>
            {canConfigure && (
              <>
                <Link to={`/knowledge/${data.id}/edit`} className={styles.secondaryButton}><Edit size={15} /> {t('edit')}</Link>
                <button type="button" className={styles.dangerButton} onClick={handleDelete} disabled={deleting}>
                  <Trash2 size={15} /> {t('delete')}
                </button>
              </>
            )}
          </div>
        }
      />

      {data.tags.length > 0 && (
        <div className={styles.tagStrip} role="list">
          {data.tags.map((tag) => <span key={tag} className={styles.tagChip}>{tag}</span>)}
        </div>
      )}

      <div className={styles.grid2}>
        <section className={styles.card} data-tone="danger">
          <h2 className={styles.cardTitle}><TriangleAlert size={15} /> {t('kb_phenomenon')}</h2>
          <p className={styles.cardBody}>{data.phenomenon || t('kb_no_phenomenon')}</p>
        </section>
        <section className={styles.card} data-tone="warning">
          <h2 className={styles.cardTitle}><CheckCircle2 size={15} /> {t('kb_root_cause')}</h2>
          <p className={styles.cardBody}>{data.rootCause || t('kb_no_root_cause')}</p>
        </section>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t('kb_solution')}</h2>
          <button type="button" className={styles.copyButton} onClick={copySolution}>
            <Copy size={14} /> {copied ? t('kb_copy_done') : t('kb_copy')}
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
    </div>
  );
}
