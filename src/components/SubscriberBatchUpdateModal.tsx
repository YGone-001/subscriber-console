"use client";

import { AlertTriangle, ClipboardCheck, Save, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { OperationNotice } from "./OperationFeedback";
import { Dialog } from "./ui/Dialog";
import "./modals.css";

type ApprovalResponse = { approval?: { id: string; changeId?: string }; requiresApproval?: boolean };
type Props = { isOpen: boolean; selectedImsis: string[]; onClose: () => void; onSuccess: (response: ApprovalResponse) => void };

export default function SubscriberBatchUpdateModal({ isOpen, selectedImsis, onClose, onSuccess }: Props) {
  const [accessRestrictionData, setAccessRestrictionData] = useState("");
  const [changeDownlink, setChangeDownlink] = useState(false);
  const [downlinkValue, setDownlinkValue] = useState("100");
  const [reason, setReason] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previewImsis = useMemo(() => selectedImsis.slice(0, 3), [selectedImsis]);
  const hasPatch = Boolean(accessRestrictionData) || changeDownlink;

  useEffect(() => { if (isOpen) setError(null); }, [isOpen]);
  if (!isOpen) return null;

  const submit = async () => {
    if (!hasPatch) { setError("Select at least one allowed subscriber field to change."); return; }
    if (reason.trim().length < 3) { setError("Reason must contain at least 3 characters."); return; }
    const numericDownlink = Number(downlinkValue);
    if (changeDownlink && (!Number.isSafeInteger(numericDownlink) || numericDownlink < 1 || numericDownlink > 10_000_000)) { setError("Downlink AMBR must be a whole number from 1 to 10,000,000."); return; }
    setIsSaving(true); setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (accessRestrictionData) patch.accessRestrictionData = Number(accessRestrictionData);
      if (changeDownlink) patch.ambr = { downlink: { value: numericDownlink, unit: 3 } };
      const response = await fetch("/api/subscribers/batch-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imsis: selectedImsis, patch, reason: reason.trim(), ticketId: ticketId.trim() || undefined }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.code || body.error || "Unable to create change request.");
      onSuccess(body); onClose();
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Unable to create change request."); }
    finally { setIsSaving(false); }
  };

  return <Dialog open={isOpen} onClose={() => { if (!isSaving) onClose(); }} overlayClassName="modal-overlay" className="modal-content animate-modal-enter bu-modal-content" labelledBy="subscriber-batch-update-title" initialFocusRef={cancelRef} closeOnOverlay={!isSaving}>
    <div className="workflow-header bu-header"><div><h2 id="subscriber-batch-update-title" className="bu-title"><Settings2 size={18} /> 批量修改订阅用户</h2><p>High-risk core changes create an approval request; subscriber data stays unchanged until execution.</p></div><button type="button" className="btn-icon" onClick={onClose} aria-label="Close" disabled={isSaving}><X size={22} /></button></div>
    <div className="bu-body">
      <div className="bu-warning"><AlertTriangle size={17} /><span>审批前仅创建 CHG 申请；审批通过后仍需单独执行冻结的变更内容。</span></div>
      <div className="bu-grid"><label className="form-label">接入限制<select className="form-input" value={accessRestrictionData} onChange={(event) => setAccessRestrictionData(event.target.value)}><option value="">不修改</option><option value="32">正常接入 (32)</option><option value="255">限制接入 (255)</option></select></label><label className="bu-check"><input type="checkbox" checked={changeDownlink} onChange={(event) => setChangeDownlink(event.target.checked)} /> 修改下行 AMBR</label>{changeDownlink ? <label className="form-label">下行 AMBR（xCloud value，unit=3）<input className="form-input" inputMode="numeric" value={downlinkValue} onChange={(event) => setDownlinkValue(event.target.value.replace(/\D/g, ""))} /></label> : null}</div>
      <label className="form-label">变更原因 <textarea className="form-input" rows={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="填写工单或维护原因（至少 3 个字符）" /></label>
      <label className="form-label">工单号（可选）<input className="form-input" maxLength={200} value={ticketId} onChange={(event) => setTicketId(event.target.value)} placeholder="CHG-20260828-001" /></label>
      <section className="bu-preview" aria-label="Batch change preview"><div><ClipboardCheck size={16} /> 提交预览</div><dl><div><dt>目标用户</dt><dd>{selectedImsis.length}</dd></div><div><dt>变更字段</dt><dd>{[accessRestrictionData ? "接入限制" : null, changeDownlink ? "下行 AMBR" : null].filter(Boolean).join("、") || "未选择"}</dd></div></dl><code>{previewImsis.join(", ")}{selectedImsis.length > previewImsis.length ? ` +${selectedImsis.length - previewImsis.length}` : ""}</code></section>
      {error ? <OperationNotice presentation="modal" tone="danger" title="无法提交变更申请" message={error} onClose={() => setError(null)} /> : null}
    </div>
    <div className="workflow-footer bu-footer"><span>服务器将重新验证权限、风险与冻结快照。</span><div className="workflow-footer-actions"><button ref={cancelRef} type="button" className="btn btn-outline" onClick={onClose} disabled={isSaving}>取消</button><button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={isSaving || selectedImsis.length === 0}><Save size={16} />{isSaving ? "正在创建…" : "提交审批"}</button></div></div>
  </Dialog>;
}
