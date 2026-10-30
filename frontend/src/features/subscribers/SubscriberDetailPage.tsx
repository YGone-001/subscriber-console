/*
 * Subscriber detail workspace.
 *
 * The record used to live in a modal opened from the list: no address, no
 * back/forward semantics, and a scroll container that had to suppress its own
 * page-level notices so they would not cover the dialogs inside it. It is now a
 * route, matching every other first-class entity in the console
 * (`/profile/:name`, `/inventory/:id`, `/users/:username`), with view and edit
 * as two states of one page instead of two layers.
 *
 * Creation is the same page without an IMSI (`/subscribers/new`), which is the
 * convention the template and inventory surfaces already follow.
 */
import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { ArrowLeft, BatteryCharging, Copy, CreditCard, Layers, Pencil, Save, Trash2 } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import { useAppParam, useAppRouter } from '../../lib/ui-compat/router';
import { copyText } from '../../lib/clipboard';
import PageHeader from '../../components/ui/PageHeader';
import { ConfirmActionPanel, OperationNotice } from '../../components/ui/OperationFeedback';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '../../components/ui/UnsavedChangesGuard';
import ProfileSectionNav from '../profiles/components/ProfileSectionNav';
import TrafficAdjustmentModal from '../../components/TrafficAdjustmentModal';
import CreateContractDialog from '../../components/ocs/contracts/CreateContractDialog';
import SubscriberViewMode from './components/subscriber/SubscriberViewMode';
import SubscriberEditMode from './components/subscriber/SubscriberEditMode';
import { SubscriberTemplateCard } from './components/SubscriberTemplateCard';
import { useSubscriberForm } from './useSubscriberForm';

export function SubscriberDetailPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const router = useAppRouter();
  const { mutate: globalMutate } = useSWRConfig();

  const routeParam = useAppParam('imsi');
  /* `/subscribers/new` is the create surface; any other value is an IMSI. */
  const imsi = routeParam && routeParam !== 'new' ? routeParam : null;

  const [isTrafficModalOpen, setIsTrafficModalOpen] = useState(false);
  const [isCreateContractOpen, setIsCreateContractOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);

  /* Every cached subscriber list is stale after a write; the surface cannot know
   * which filter combination the operator came from. */
  const refreshLists = () => {
    void globalMutate(
      (key) => typeof key === 'string' && key.startsWith('/api/subscribers?'),
      undefined,
      { revalidate: true },
    );
  };

  const goToList = () => router.push('/subscribers');

  const { state, actions } = useSubscriberForm(
    imsi,
    t,
    goToList,
    refreshLists,
    (_savedImsi, created) => {
      if (created) {
        goToList();
        return;
      }
      /* Saving leaves the operator on the record they were editing, now showing
       * the stored values again. */
      setNotice(t('sub_msg_saved'));
      actions.discardDraft();
    },
  );
  const {
    isEditing, isLoading, isSaving, error, toastMessage, hasUnsavedChanges,
    inputImsi, inputImsiExists, isCheckingInputImsi, inputMsisdnExists, isCheckingInputMsisdn,
    msisdn, slices, ocsTrafficTotalStr, ocsTrafficBalanceStr,
  } = state;
  const { setIsEditing, handleSave, handleDelete, scrollTo, discardDraft, clearError, clearToastMessage } = actions;

  const canEditSubscribers = hasPermission(user, 'subscribers.write');
  const canAdjustBalance = hasPermission(user, 'ocs.balance.adjust');
  const canAssignPlan = hasPermission(user, 'ocs.plan.assign');
  const isCreate = imsi === null;

  /* Discarding edits on a record restores it in place; discarding a create
   * leaves the page, because there is nothing to restore. */
  const confirmDiscard = () => {
    if (isCreate) {
      goToList();
      return;
    }
    discardDraft();
  };

  const unsavedGuard = useUnsavedChangesGuard(() => hasUnsavedChanges, confirmDiscard);

  const sections = isEditing
    ? [
      { id: 'sec-identity', label: t('sub_step_id') },
      { id: 'sec-security', label: t('sec_security_auth') },
      { id: 'sec-rating', label: t('sec_billing_config') },
      { id: 'sec-network', label: t('sec_global_network') },
      { id: 'sec-access-restrictions', label: t('sec_access_restrict') },
      { id: 'sec-slices', label: t('sub_slices_arch') },
    ]
    : [
      { id: 'sec-subscription-overview', label: t('sub_360_nav') },
      { id: 'sec-security', label: t('sec_security_auth') },
      { id: 'sec-network', label: t('sub_network_config') },
      { id: 'sec-ocs-view', label: t('sec_billing_config') },
      { id: 'sec-slices', label: t('sub_slices_arch') },
    ];

  const handleCopyImsi = async () => {
    if (!imsi) return;
    if (!(await copyText(imsi))) return;
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 1400);
  };

  const requestCancel = () => {
    if (hasUnsavedChanges) {
      unsavedGuard.requestClose();
      return;
    }
    if (isCreate) {
      goToList();
      return;
    }
    discardDraft();
  };

  const confirmDelete = async () => {
    setIsDeleting(true);
    await handleDelete();
    setIsDeleting(false);
    setIsDeleteOpen(false);
  };

  const saveDisabled = isSaving
    || isCheckingInputImsi
    || isCheckingInputMsisdn
    || inputImsiExists
    || inputMsisdnExists
    || (isCreate && !inputImsi);

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('eyebrow_imsi_hss')}
        icon={<Layers size={23} />}
        title={isCreate ? t('sub_new_title') : (imsi || '')}
        description={isCreate ? t('sub_new_desc') : t('sub_detail_desc')}
        actions={
          <div className="page-action-buttons">
            <button type="button" className="btn btn-outline" onClick={isCreate || isEditing ? requestCancel : goToList} disabled={isSaving}>
              <ArrowLeft size={16} /> {isEditing || isCreate ? t('cancel') : t('back')}
            </button>
            {!isCreate && (
              <button type="button" className="btn btn-outline" onClick={() => { void handleCopyImsi(); }}>
                <Copy size={16} /> {isCopied ? t('sub_copy_imsi_done') : t('sub_copy_imsi')}
              </button>
            )}
            {isCreate || isEditing ? (
              <button type="button" className="btn btn-primary" onClick={() => { void handleSave(); }} disabled={saveDisabled}>
                <Save size={16} /> {isSaving ? t('saving') : isCreate ? t('add_subscriber') : t('save')}
              </button>
            ) : (
              <>
                {canAssignPlan && !state.hasOcsContract && !isLoading && (
                  <button type="button" className="btn btn-outline" onClick={() => setIsCreateContractOpen(true)}>
                    <CreditCard size={16} /> {t('ocs_contract_create_action')}
                  </button>
                )}
                {canAdjustBalance && state.hasOcsBalance && state.ocsContractStatus !== 'terminated' && (
                  <button type="button" className="btn btn-outline" onClick={() => setIsTrafficModalOpen(true)}>
                    <BatteryCharging size={16} /> {t('traffic_adjust')}
                  </button>
                )}
                {canEditSubscribers && (
                  <button type="button" className="btn btn-primary" onClick={() => setIsEditing(true)}>
                    <Pencil size={16} /> {t('sub_btn_edit')}
                  </button>
                )}
                {canEditSubscribers && (
                  <button type="button" className="btn btn-danger" onClick={() => setIsDeleteOpen(true)}>
                    <Trash2 size={16} /> {t('delete')}
                  </button>
                )}
              </>
            )}
          </div>
        }
      />

      {notice && (
        <OperationNotice presentation="inline" tone="success" message={notice} onClose={() => setNotice(null)} />
      )}
      {toastMessage && (
        <OperationNotice presentation="inline" tone="success" title={t('success')} message={toastMessage} onClose={clearToastMessage} />
      )}
      {error && (
        <OperationNotice presentation="inline" tone="danger" title={t('error')} message={error} onClose={clearError} />
      )}
      {cardError && (
        <OperationNotice presentation="inline" tone="danger" title={t('error')} message={cardError} onClose={() => setCardError(null)} />
      )}

      {isLoading ? (
        <div className="dash-card">
          <div className="dash-card-body">{t('sub_loading_data')}</div>
        </div>
      ) : (
        <>
          <ProfileSectionNav
            sections={sections}
            label={t('sub_section_nav_label')}
            onJump={scrollTo}
          />
          {isEditing ? (
            <SubscriberEditMode t={t} imsi={imsi} state={state} actions={actions} />
          ) : (
            <SubscriberViewMode
              t={t}
              auth4GData={state.auth4GData}
              usimType={state.usimType}
              ueAmbr={state.ueAmbr}
              hasUeAmbr={state.hasUeAmbr}
              imsi={imsi || inputImsi}
              msisdn={msisdn}
              accessRestriction={state.accessRestriction}
              ocsTrafficTotalStr={ocsTrafficTotalStr}
              ocsTrafficBalanceStr={ocsTrafficBalanceStr}
              ocsVoiceTotalStr={state.ocsVoiceTotalStr}
              ocsVoiceBalanceStr={state.ocsVoiceBalanceStr}
              ocsSmsTotalStr={state.ocsSmsTotalStr}
              ocsSmsBalanceStr={state.ocsSmsBalanceStr}
              ocsPlmn={state.ocsPlmn}
              ocsPlanId={state.ocsPlanId}
              ocsPlanStatus={state.ocsPlanStatus}
              ocsContractStatus={state.ocsContractStatus}
              hasOcsContract={state.hasOcsContract}
              hasOcsBalance={state.hasOcsBalance}
              ocsVolumeThreshold={state.ocsVolumeThreshold}
              ocsDataReservedStr={state.ocsDataReservedStr}
              ocsRules={state.ocsRules}
              ratingList={state.ratingList}
              slices={slices}
              expandedSlices={state.expandedSlices}
              setExpandedSlices={actions.setExpandedSlices}
              canRevealCredentials={canEditSubscribers}
            />
          )}
          {!isCreate && (
            <SubscriberTemplateCard
              imsi={imsi}
              binding={state.profileBinding}
              profileList={state.profileList}
              profilesReady={state.profilesReady}
              canApply={canEditSubscribers}
              onOpenTemplate={(name) => router.push(`/profile/${encodeURIComponent(name)}`)}
              onApplied={(message) => {
                setCardError(null);
                setNotice(message);
                refreshLists();
                actions.discardDraft();
              }}
              onError={(message) => { setNotice(null); setCardError(message); }}
            />
          )}
        </>
      )}

      {isDeleteOpen && imsi && (
        <ConfirmActionPanel
          tone="danger"
          title={t('sub_confirm_delete_title')}
          message={t('sub_confirm_delete_desc', { items: imsi })}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          isWorking={isDeleting}
          onConfirm={() => { void confirmDelete(); }}
          onCancel={() => setIsDeleteOpen(false)}
        />
      )}

      {!isCreate && imsi && (
        <CreateContractDialog
          open={isCreateContractOpen}
          initialImsi={imsi}
          onClose={() => setIsCreateContractOpen(false)}
          onCreated={(createdImsi, balanceAdopted) => {
            setIsCreateContractOpen(false);
            setNotice(t(balanceAdopted ? 'ocs_contract_create_success_adopted' : 'ocs_contract_create_success', { imsi: createdImsi }));
            refreshLists();
            discardDraft();
          }}
        />
      )}

      {isTrafficModalOpen && imsi && (
        <TrafficAdjustmentModal
          imsi={imsi}
          onClose={() => setIsTrafficModalOpen(false)}
          onSuccess={() => {
            setIsTrafficModalOpen(false);
            setNotice(t('traffic_success'));
            refreshLists();
          }}
          t={t}
        />
      )}

      <UnsavedChangesDialog
        open={unsavedGuard.isPromptOpen}
        title={t('unsaved_changes_title')}
        description={t('unsaved_changes_description')}
        keepEditingLabel={t('unsaved_changes_keep_editing')}
        discardLabel={t('unsaved_changes_discard')}
        onKeepEditing={unsavedGuard.keepEditing}
        onDiscard={unsavedGuard.discardChanges}
      />
    </div>
  );
}
