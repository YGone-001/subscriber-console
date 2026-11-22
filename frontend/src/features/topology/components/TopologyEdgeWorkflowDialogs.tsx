/*
 * Governed relationship dialogs.
 *
 * The three overlays - create, edit, retire - plus the revision-conflict banner,
 * rendered from the workflow owner's state. Nothing here submits on its own: a
 * dialog closes only through an explicit action, an in-flight request blocks
 * dismissal, and the retire form cannot be confirmed without a reason.
 */
import { useI18n } from '../../../providers/I18nProvider';
import { Dialog } from '../../../components/ui/Dialog';
import { Field } from '../../../components/ui/Field';
import { TopologyEdgeForm } from './TopologyEdgeForm';
import { RELATIONSHIP_PRESENTATION, type TopologyMetaResponse } from '../topology-types';
import type { TopologyEdgeWorkflows } from '../use-topology-edge-workflows';
import styles from '../../../styles/modules/topology.module.css';

export type TopologyEdgeWorkflowDialogsProps = {
  workflows: TopologyEdgeWorkflows;
  meta: TopologyMetaResponse | null;
};

export function TopologyEdgeWorkflowDialogs({ workflows, meta }: TopologyEdgeWorkflowDialogsProps) {
  const { t } = useI18n();
  const {
    createOpen,
    editTarget,
    retireTarget,
    retireReason,
    submitting,
    formError,
    conflictNotice,
    setRetireReason,
    closeCreate,
    closeEdit,
    closeRetire,
    submitCreate,
    submitUpdate,
    submitRetire,
    acknowledgeConflict,
  } = workflows;

  const relationshipLabel = (value: string) => {
    const presentation = RELATIONSHIP_PRESENTATION[value];
    return presentation ? t(presentation.labelKey) : value;
  };

  return (
    <>
      {conflictNotice ? (
        <div className={styles.conflictBanner} role="alert">
          <span>{conflictNotice}</span>
          <button type="button" className="btn btn-secondary" onClick={acknowledgeConflict}>
            {t('topology_reload')}
          </button>
        </div>
      ) : null}

      <Dialog
        open={createOpen}
        onClose={closeCreate}
        overlayClassName={`modal-overlay ${styles.modalOverlay}`}
        className={`modal-content animate-fade-in ${styles.modalContent}`}
        labelledBy="topology-create-title"
        closeOnOverlay={!submitting}
        closeOnEscape={!submitting}
      >
        <div className={styles.modalHeader}>
          <h2 id="topology-create-title">{t('topology_create_relationship')}</h2>
        </div>
        <div className={styles.modalBody}>
          <p className={styles.modalIntro}>{t('topology_create_intro')}</p>
          <TopologyEdgeForm
            mode="create"
            relationshipTypes={meta?.relationshipTypes ?? []}
            interfaceCatalog={meta?.interfaceCatalog ?? []}
            submitting={submitting}
            serverError={formError}
            onCancel={closeCreate}
            onCreate={submitCreate}
          />
        </div>
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onClose={closeEdit}
        overlayClassName={`modal-overlay ${styles.modalOverlay}`}
        className={`modal-content animate-fade-in ${styles.modalContent}`}
        labelledBy="topology-edit-title"
        closeOnOverlay={!submitting}
        closeOnEscape={!submitting}
      >
        <div className={styles.modalHeader}>
          <h2 id="topology-edit-title">{t('topology_edit_relationship')}</h2>
        </div>
        <div className={styles.modalBody}>
          {editTarget ? (
            <TopologyEdgeForm
              mode="edit"
              relationshipTypes={meta?.relationshipTypes ?? []}
              interfaceCatalog={meta?.interfaceCatalog ?? []}
              initialEdge={editTarget}
              submitting={submitting}
              serverError={formError}
              onCancel={closeEdit}
              onUpdate={submitUpdate}
            />
          ) : null}
        </div>
      </Dialog>

      <Dialog
        open={retireTarget !== null}
        onClose={closeRetire}
        overlayClassName={`modal-overlay ${styles.modalOverlay}`}
        className={`modal-content animate-fade-in ${styles.modalContent}`}
        labelledBy="topology-retire-title"
        closeOnOverlay={!submitting}
        closeOnEscape={!submitting}
      >
        <div className={styles.modalHeader}>
          <h2 id="topology-retire-title">{t('topology_retire_title')}</h2>
        </div>
        <div className={styles.modalBody}>
          {retireTarget ? (
            <>
              <dl className={styles.identityReadonly}>
                <div>
                  <dt>{t('topology_from_resource')}</dt>
                  <dd><code className={styles.uuid}>{retireTarget.fromResourceId}</code></dd>
                </div>
                <div>
                  <dt>{t('topology_relationship')}</dt>
                  <dd>{relationshipLabel(retireTarget.relationshipType)}</dd>
                </div>
                <div>
                  <dt>{t('topology_to_resource')}</dt>
                  <dd><code className={styles.uuid}>{retireTarget.toResourceId}</code></dd>
                </div>
                <div>
                  <dt>{t('topology_revision')}</dt>
                  <dd>r{retireTarget.revision}</dd>
                </div>
              </dl>
              <p className={styles.retireWarning}>{t('topology_retire_warning')}</p>
              <Field htmlFor="topology-retire-reason" label={t('topology_retire_reason')}>
                <textarea
                  id="topology-retire-reason"
                  className="form-input"
                  rows={2}
                  value={retireReason}
                  onChange={(event) => setRetireReason(event.target.value)}
                  disabled={submitting}
                  aria-invalid={!retireReason.trim() && formError ? true : undefined}
                />
              </Field>
              {formError ? <p className={styles.formError} role="alert">{formError}</p> : null}
              <div className={styles.formActions}>
                <button type="button" className="btn btn-secondary" onClick={closeRetire} disabled={submitting}>
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void submitRetire()}
                  disabled={submitting || !retireReason.trim()}
                >
                  {submitting ? t('topology_submitting') : t('topology_retire_confirm')}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
