"use client";

import { Save, Trash2, X, Pencil, Check, Layers, Copy, BatteryCharging } from "lucide-react";
import { useState } from "react";
import { useI18n } from "./I18nProvider";
import SubscriberViewMode from "./subscriber/SubscriberViewMode";
import SubscriberEditMode from "./subscriber/SubscriberEditMode";
import TrafficAdjustmentModal from "./TrafficAdjustmentModal";
import { useSubscriberForm } from "@/hooks/useSubscriberForm";
import { formatBytes, parseBytes } from "@/lib/unitParser";

interface SubscriberModalProps {
  imsi: string | null;
  onClose: () => void;
  onRefresh: () => void;
}

export default function SubscriberModal({ imsi, onClose, onRefresh }: SubscriberModalProps) {
  const { t } = useI18n();
  const [isTrafficModalOpen, setIsTrafficModalOpen] = useState(false);
  const { state, actions } = useSubscriberForm(imsi, t, onClose, onRefresh);
  const {
    isEditing, isLoading, isSaving, error, inputImsi, toastMessage,
    slices, ocsPlanId, ocsTrafficTotalStr, ocsTrafficBalanceStr
  } = state;
  const { handleDelete, handleSave, setIsEditing, scrollTo } = actions;
  const trafficTotal = parseBytes(ocsTrafficTotalStr);
  const trafficBalance = parseBytes(ocsTrafficBalanceStr);
  const trafficUsed = Math.max(0, trafficTotal - trafficBalance);

  const renderViewMode = () => {
    return <SubscriberViewMode
      t={t}
      auth4GData={state.auth4GData}
      usimType={state.usimType}
      ueAmbr={state.ueAmbr}
      ocsTrafficTotalStr={state.ocsTrafficTotalStr}
      ocsTrafficBalanceStr={state.ocsTrafficBalanceStr}
      ocsPlmn={state.ocsPlmn}
      ocsPlanId={state.ocsPlanId}
      ocsPlanStatus={state.ocsPlanStatus}
      ocsRules={state.ocsRules}
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
          <div className="toast-container">
            <div className="toast">{toastMessage}</div>
          </div>
        )}

        <div className="workflow-header">
          <div className="workflow-title-group">
            <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
              {imsi ? (
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <h2 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 600, color: "var(--text-main)", fontFamily: "monospace" }}>{imsi}</h2>
                  <button className="copy-btn" onClick={() => navigator.clipboard.writeText(imsi)} title="Copy IMSI" style={{ padding: "6px" }}>
                    <Copy size={20} />
                  </button>
                </div>
              ) : (
                <div>
                  <h2 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 600, color: "var(--text-main)" }}>{t("sub_new_title")}</h2>
                  <p style={{ margin: "0.25rem 0 0", color: "var(--text-muted)", fontSize: "0.9rem" }}>{t("sub_new_desc")}</p>
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

            <div style={{ width: "1px", height: "30px", background: "var(--surface-border)", margin: "0 0.5rem" }} />
            <button className="btn-icon" onClick={onClose} title={t("close")}><X size={26} color="var(--text-muted)" /></button>
          </div>
        </div>

        <div className="workflow-body">
          <div className="workflow-sidebar">
            <h4 style={{ fontSize: "0.85rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "1rem", paddingLeft: "0.5rem" }}>{t("sub_overview")}</h4>
            {isEditing && (
              <button className="workflow-step" onClick={() => scrollTo('sec-identity')}>
                <span className="workflow-step-index">1</span>
                <span className="workflow-step-label"><strong>{t("sub_step_id")}</strong><span>{t("sub_step_id_desc")}</span></span>
              </button>
            )}
            <button className="workflow-step" onClick={() => scrollTo('sec-security')}>
              <span className="workflow-step-index">{isEditing ? "2" : "1"}</span>
              <span className="workflow-step-label"><strong>{t("sub_step_sec")}</strong><span>{t("sub_step_sec_desc")}</span></span>
            </button>
            <button className="workflow-step" onClick={() => scrollTo(isEditing ? 'sec-rating' : 'sec-ocs-view')}>
              <span className="workflow-step-index">{isEditing ? "3" : "2"}</span>
              <span className="workflow-step-label"><strong>{t("sub_step_bill")}</strong><span>{t("sub_step_bill_desc")}</span></span>
            </button>
            <button className="workflow-step" onClick={() => scrollTo('sec-network')}>
              <span className="workflow-step-index">{isEditing ? "4" : "3"}</span>
              <span className="workflow-step-label"><strong>{t("sub_step_net")}</strong><span>{t("sub_step_net_desc")}</span></span>
            </button>
            <button className="workflow-step" onClick={() => scrollTo('sec-access-restrictions')}>
              <span className="workflow-step-index">{isEditing ? "5" : "4"}</span>
              <span className="workflow-step-label"><strong>{t("sub_step_acc")}</strong><span>{t("sub_step_acc_desc")}</span></span>
            </button>
            <button className="workflow-step" onClick={() => scrollTo('sec-slices')}>
              <span className="workflow-step-index">{isEditing ? "6" : "5"}</span>
              <span className="workflow-step-label"><strong>{t("sub_step_slice")}</strong><span>{t("sub_step_slice_desc")}</span></span>
            </button>
          </div>

          <div className="workflow-content">
            {error && (
              <div className="dash-card" style={{ borderLeft: '4px solid var(--danger)', marginBottom: '1.5rem', padding: "1rem 1.5rem", background: "var(--surface)" }}>
                <p style={{ color: 'var(--danger)', margin: 0, fontWeight: 600 }}>{error}</p>
              </div>
            )}

            {isLoading ? (
              <div style={{ textAlign: "center", marginTop: "4rem", color: "var(--text-muted)", fontSize: "1.1rem" }}>{t("sub_loading_data")}</div>
            ) : (
              <div className="workflow-content-inner">
                {isEditing ? renderEditMode() : renderViewMode()}
              </div>
            )}
          </div>
        </div>

        <div className="workflow-footer">
          <div style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
            {isEditing ? t("sub_msg_edit") : t("sub_msg_view")}
          </div>
          <div className="workflow-footer-actions">
            <button className="btn btn-outline" onClick={onClose}>{t("cancel")}</button>
            {isEditing ? (
              <button className="btn btn-primary" onClick={handleSave} disabled={isSaving || (!imsi && !inputImsi)}>
                <Save size={16}/> {isSaving ? t("sub_btn_saving") : (imsi ? t("sub_btn_save") : t("sub_btn_create"))}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => setIsEditing(true)}>
                <Pencil size={16}/> {t("sub_btn_edit")}
              </button>
            )}
          </div>
        </div>

      </div>

      {imsi && isTrafficModalOpen && (
        <TrafficAdjustmentModal
          imsi={imsi}
          t={t}
          currentTraffic={{ total: trafficTotal, balance: trafficBalance, used: trafficUsed }}
          onClose={() => setIsTrafficModalOpen(false)}
          onSuccess={(adjustment) => {
            if (adjustment?.after) {
              actions.setOcsTrafficTotalStr(formatBytes(adjustment.after.traffic_total));
              actions.setOcsTrafficBalanceStr(formatBytes(adjustment.after.traffic_balance));
            }
            onRefresh();
          }}
        />
      )}
    </div>
  );
}
