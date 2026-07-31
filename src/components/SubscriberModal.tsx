"use client";

import { Save, Trash2, X, Pencil, Check, Layers, Copy, BatteryCharging } from "lucide-react";
import { useState } from "react";
import { useI18n } from "./I18nProvider";
import SubscriberViewMode from "./subscriber/SubscriberViewMode";
import SubscriberEditMode from "./subscriber/SubscriberEditMode";
import TrafficAdjustmentModal from "./TrafficAdjustmentModal";
import { useSubscriberForm } from "@/hooks/useSubscriberForm";
import { formatBytes, parseBytes } from "@/lib/unitParser";
import { OperationNotice } from "./OperationFeedback";
import "./SubscriberModal.css";

interface SubscriberModalProps {
  imsi: string | null;
  onClose: () => void;
  onRefresh: () => void;
}

export default function SubscriberModal({ imsi, onClose, onRefresh }: SubscriberModalProps) {
  const { t } = useI18n();
  const [isTrafficModalOpen, setIsTrafficModalOpen] = useState(false);
  const [isImsiCopied, setIsImsiCopied] = useState(false);
  const { state, actions } = useSubscriberForm(imsi, t, onClose, onRefresh);
  const {
    isEditing, isLoading, isSaving, error, inputImsi, toastMessage,
    slices, ocsPlanId, ocsTrafficTotalStr, ocsTrafficBalanceStr,
    inputImsiExists, isCheckingInputImsi, inputMsisdnExists, isCheckingInputMsisdn
  } = state;
  const { handleDelete, handleSave, setIsEditing, scrollTo, clearError, clearToastMessage } = actions;
  const trafficTotal = parseBytes(ocsTrafficTotalStr);
  const trafficBalance = parseBytes(ocsTrafficBalanceStr);
  const trafficUsed = Math.max(0, trafficTotal - trafficBalance);
  const handleCopyImsi = () => {
    if (!imsi) return;
    navigator.clipboard.writeText(imsi);
    setIsImsiCopied(true);
    setTimeout(() => setIsImsiCopied(false), 2000);
  };

  const renderViewMode = () => {
    return <SubscriberViewMode
      t={t}
      auth4GData={state.auth4GData}
      usimType={state.usimType}
      ueAmbr={state.ueAmbr}
      imsi={imsi || state.inputImsi}
      msisdn={state.msisdn}
      accessRestriction={state.accessRestriction}
      ocsTrafficTotalStr={state.ocsTrafficTotalStr}
      ocsTrafficBalanceStr={state.ocsTrafficBalanceStr}
      ocsVoiceTotalStr={state.ocsVoiceTotalStr}
      ocsVoiceBalanceStr={state.ocsVoiceBalanceStr}
      ocsSmsTotalStr={state.ocsSmsTotalStr}
      ocsSmsBalanceStr={state.ocsSmsBalanceStr}
      ocsPlmn={state.ocsPlmn}
      ocsPlanId={state.ocsPlanId}
      ocsPlanStatus={state.ocsPlanStatus}
      ocsRules={state.ocsRules}
      ratingList={state.ratingList}
      slices={state.slices}
      expandedSlices={state.expandedSlices}
      setExpandedSlices={actions.setExpandedSlices}
    />;
  };

  const renderEditMode = () => {
    return <SubscriberEditMode
      t={t}
      imsi={imsi}
      state={state}
      actions={actions}
    />;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content workflow-modal animate-modal-enter" onClick={e => e.stopPropagation()}>

        {toastMessage && (
          <OperationNotice
            presentation="modal"
            tone="success"
            title={t("success")}
            message={toastMessage}
            onClose={clearToastMessage}
          />
        )}

        <div className="workflow-header">
          <div className="workflow-title-group">
            <div className="sub-modal-imsi-row">
              {imsi ? (
                <div className="sub-modal-imsi-group">
                  <h2 className="sub-modal-imsi-title">{imsi}</h2>
                  <button className="copy-btn sub-modal-imsi-copy-btn" onClick={handleCopyImsi} title={t("sub_copy_imsi")}>
                    {isImsiCopied ? <Check size={20} color="var(--success)" /> : <Copy size={20} />}
                  </button>
                </div>
              ) : (
                <div>
                  <h2 className="sub-modal-new-title">{t("sub_new_title")}</h2>
                  <p className="sub-modal-new-desc">{t("sub_new_desc")}</p>
                </div>
              )}
              {ocsPlanId && <span className="badge-active"><Check size={12}/> {t("sub_billing_active")}</span>}
              {slices.length > 1 && <span className="badge-secondary"><Layers size={12}/> {t("sub_multi_slice")}</span>}
            </div>
          </div>

          <div className="workflow-header-actions">
            {!isEditing && (
              <>
                {imsi && (
                  <button className="btn-icon" onClick={() => setIsTrafficModalOpen(true)} title={t("traffic_adjust")}>
                    <BatteryCharging size={24} color="var(--primary)" />
                  </button>
                )}
                <button className="btn-icon" onClick={() => setIsEditing(true)} title={t("sub_btn_edit")}><Pencil size={24} color="var(--primary)" /></button>
              </>
            )}

            {imsi && <button className="btn-icon" onClick={handleDelete} title={t("sub_btn_delete")}><Trash2 size={24} color="var(--danger)" /></button>}

            <div className="sub-modal-header-divider" />
            <button className="btn-icon" onClick={onClose} title={t("close")}><X size={26} color="var(--text-muted)" /></button>
          </div>
        </div>

        <div className="workflow-body">
          <div className="workflow-sidebar">
            <h4 className="sub-modal-sidebar-title">{t("sub_overview")}</h4>
            {isEditing && (
              <button className="workflow-step" onClick={() => scrollTo('sec-identity')}>
                <span className="workflow-step-index">1</span>
                <span className="workflow-step-label"><strong>{t("sub_step_id")}</strong><span>{t("sub_step_id_desc")}</span></span>
              </button>
            )}
            {isEditing ? (
              <>
                <button className="workflow-step" onClick={() => scrollTo('sec-security')}>
                  <span className="workflow-step-index">2</span>
                  <span className="workflow-step-label"><strong>{t("sub_step_sec")}</strong><span>{t("sub_step_sec_desc")}</span></span>
                </button>
                <button className="workflow-step" onClick={() => scrollTo('sec-rating')}>
                  <span className="workflow-step-index">3</span>
                  <span className="workflow-step-label"><strong>{t("sub_step_bill")}</strong><span>{t("sub_step_bill_desc")}</span></span>
                </button>
                <button className="workflow-step" onClick={() => scrollTo('sec-network')}>
                  <span className="workflow-step-index">4</span>
                  <span className="workflow-step-label"><strong>{t("sub_step_net")}</strong><span>{t("sub_step_net_desc")}</span></span>
                </button>
                <button className="workflow-step" onClick={() => scrollTo('sec-access-restrictions')}>
                  <span className="workflow-step-index">5</span>
                  <span className="workflow-step-label"><strong>{t("sub_step_acc")}</strong><span>{t("sub_step_acc_desc")}</span></span>
                </button>
                <button className="workflow-step" onClick={() => scrollTo('sec-slices')}>
                  <span className="workflow-step-index">6</span>
                  <span className="workflow-step-label"><strong>{t("sub_step_slice")}</strong><span>{t("sub_step_slice_desc")}</span></span>
                </button>
              </>
            ) : (
              <>
                <button className="workflow-step" onClick={() => scrollTo('sec-subscription-overview')}>
                  <span className="workflow-step-index">1</span>
                  <span className="workflow-step-label"><strong>{t("sub_360_nav")}</strong><span>{t("sub_360_nav_desc")}</span></span>
                </button>
                <button className="workflow-step" onClick={() => scrollTo('sec-technical-details')}>
                  <span className="workflow-step-index">2</span>
                  <span className="workflow-step-label"><strong>{t("sub_technical_nav")}</strong><span>{t("sub_technical_nav_desc")}</span></span>
                </button>
              </>
            )}
          </div>

          <div className="workflow-content">
            {error && (
              <OperationNotice
                presentation="modal"
                tone="danger"
                title={t("error")}
                message={error}
                onClose={clearError}
              />
            )}

            {isLoading ? (
              <div className="sub-modal-loading">{t("sub_loading_data")}</div>
            ) : (
              <div className="workflow-content-inner">
                {isEditing ? renderEditMode() : renderViewMode()}
              </div>
            )}
          </div>
        </div>

        <div className="workflow-footer">
          <div className="sub-modal-footer-msg">
            {isEditing ? t("sub_msg_edit") : t("sub_msg_view")}
          </div>
          <div className="workflow-footer-actions">
            <button className="btn btn-outline" onClick={onClose} disabled={isSaving}>{t("cancel")}</button>
            {isEditing && (
              <button 
                className={`btn btn-primary ${isSaving ? 'btn-loading' : ''}`} 
                onClick={handleSave}
                disabled={isSaving || isCheckingInputImsi || isCheckingInputMsisdn || inputImsiExists || inputMsisdnExists || (imsi === null && !inputImsi)}
              >
                <Save size={18}/> {isSaving ? t("saving") : t("save")}
              </button>
            )}
          </div>
        </div>
      </div>
      {isTrafficModalOpen && imsi && (
        <TrafficAdjustmentModal
          imsi={imsi}
          currentTraffic={{ total: trafficTotal, used: trafficUsed, balance: trafficBalance }}
          onClose={() => setIsTrafficModalOpen(false)}
          onSuccess={() => {
            setIsTrafficModalOpen(false);
            onRefresh();
          }}
          t={t}
        />
      )}
    </div>
  );
}
