import { useId, useRef } from "react";
import { Ban, CheckCircle2, Circle, CircleX, LoaderCircle, X } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { Dialog } from "@/components/ui/Dialog";
import type { BulkProgressState } from "../types";
import styles from "./UserDrawer.module.css";

interface BulkProgressModalProps {
  progress: BulkProgressState;
  onCancel: () => void;
  onClose: () => void;
}

export function BulkProgressModal({ progress, onCancel, onClose }: BulkProgressModalProps) {
  const { t } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const successCount = progress.items.filter((item) => item.status === "success").length;
  const failedCount = progress.items.filter((item) => item.status === "failed").length;
  const cancelledCount = progress.items.filter((item) => item.status === "cancelled").length;
  const processedCount = successCount + failedCount;
  const percent = progress.items.length ? Math.round((processedCount / progress.items.length) * 100) : 0;

  return (
    <Dialog
      open
      onClose={progress.completed ? onClose : () => undefined}
      overlayClassName={styles.progressLayer}
      className={styles.progressDialog}
      labelledBy={titleId}
      describedBy={descriptionId}
      initialFocusRef={actionButtonRef}
      closeOnOverlay={progress.completed}
    >
      <header className={styles.progressHeader}>
        <div>
          <span className={styles.progressIcon} data-running={!progress.completed || undefined}>{progress.completed ? <CheckCircle2 size={20} /> : <LoaderCircle size={20} />}</span>
          <div>
            <h2 id={titleId}>{t(progress.completed ? "users_bulk_progress_complete" : "users_bulk_progress_title")}</h2>
            <p id={descriptionId}>{t(`users_bulk_confirm_${progress.action}`)}</p>
          </div>
        </div>
        {progress.completed ? <button type="button" className="btn-icon" onClick={onClose} aria-label={t("close")}><X size={18} /></button> : null}
      </header>

      <section className={styles.progressSummary} aria-live="polite">
        <div><span>{t("users_bulk_progress_label")}</span><strong>{processedCount} / {progress.items.length}</strong></div>
        <div className={styles.progressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={progress.items.length} aria-valuenow={processedCount}>
          <span style={{ width: `${percent}%` }} />
        </div>
        {progress.completed ? <p>{t("users_bulk_progress_result", { success: successCount, failed: failedCount, cancelled: cancelledCount })}</p> : null}
      </section>

      <ol className={styles.progressList}>
        {progress.items.map((item) => (
          <li key={item.username} data-status={item.status}>
            <span aria-hidden="true">
              {item.status === "success" ? <CheckCircle2 size={17} /> : item.status === "failed" ? <CircleX size={17} /> : item.status === "running" ? <LoaderCircle size={17} /> : item.status === "cancelled" ? <Ban size={17} /> : <Circle size={17} />}
            </span>
            <strong>{item.username}</strong>
            <small>{item.reason || t(`users_bulk_item_${item.status}`)}</small>
          </li>
        ))}
      </ol>

      <footer className={styles.progressFooter}>
        {progress.completed ? (
          <button ref={actionButtonRef} type="button" className="btn btn-primary" onClick={onClose}>{t("close")}</button>
        ) : (
          <button ref={actionButtonRef} type="button" className="btn btn-outline" onClick={onCancel} disabled={progress.cancelRequested}>
            <Ban size={15} />{progress.cancelRequested ? t("users_bulk_cancelling") : t("users_bulk_cancel_remaining")}
          </button>
        )}
      </footer>
    </Dialog>
  );
}
