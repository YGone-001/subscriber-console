"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "./I18nProvider";
import { Save, Trash2, X, Pencil, History, RotateCcw, GitCompareArrows } from "lucide-react";
import { parseBytes, formatBytes, parseEvents, formatEvents } from "@/lib/unitParser";
import ProfileViewMode from "./profile/ProfileViewMode";
import ProfileEditMode from "./profile/ProfileEditMode";
import { useAuth } from "@/hooks/useAuth";
import { ConfirmActionPanel, LoadingRows, OperationNotice } from "./OperationFeedback";
import VisualDiffViewer from "./VisualDiffViewer";
import { UnsavedChangesDialog, useUnsavedChangesGuard } from "@/components/ui/UnsavedChangesGuard";
import "./modals.css";

// Session type mapping (IPv4/IPv6/IPv4v6)
interface ProfileModalProps {
  profileName: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onOperation?: (notice: { type: "success" | "error"; text: string }) => void;
  impactedSubscribers?: number;
}

type ProfileVersionSummary = {
  versionId: string;
  profileName: string;
  savedAt: string;
  savedBy: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE';
  title?: string;
  sliceCount: number;
};

type ProfileVersionDetail = ProfileVersionSummary & {
  profile: any;
};

type DraftDiffRow = {
  key: string;
  label: string;
  changed: boolean;
};

function buildProfileKeyFromTitle(title: string) {
  const trimmed = title.trim();
  const asciiKey = trimmed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

  if (/^[a-zA-Z0-9_\s-]+$/.test(trimmed) && trimmed.length <= 64) return trimmed;
  return `${asciiKey || "profile"}_${Date.now().toString(36)}`;
}

export default function ProfileModal({ profileName, onClose, onRefresh, onOperation, impactedSubscribers = 0 }: ProfileModalProps) {
  const { t } = useI18n();
  const { isRoot, isOperator } = useAuth();
  const [isEditing, setIsEditing] = useState(!profileName);
  const [isLoading, setIsLoading] = useState(!!profileName);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [forceDeleteCount, setForceDeleteCount] = useState<number | null>(null);
  const [isSaveConfirmOpen, setIsSaveConfirmOpen] = useState(false);
  const [isAccessRestrictionsExpanded, setIsAccessRestrictionsExpanded] = useState(false);
  const [profileSnapshot, setProfileSnapshot] = useState<any>(null);
  const [backendStats, setBackendStats] = useState<{ totalSubscribers: number; activeSubscribers: number; suspendedSubscribers: number; restrictedSubscribers: number } | null>(null);
  const [versions, setVersions] = useState<ProfileVersionSummary[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<ProfileVersionDetail | null>(null);
  const [isVersionsLoading, setIsVersionsLoading] = useState(false);
  const [restoreConfirmVersionId, setRestoreConfirmVersionId] = useState<string | null>(null);

  // Blinking animation state flag
  const [newlyAddedSliceIndex, setNewlyAddedSliceIndex] = useState<number | null>(null);

  // Profile basic info
  const [inputName, setInputName] = useState(profileName || "");
  const [profileTitle, setProfileTitle] = useState("");

  // Auth template fields
  const [authData, setAuthData] = useState({ k: "", opValue: "", amf: "8000" });
  // USIM type selection: determines opc or op key
  const [usimType, setUsimType] = useState<"opc" | "op">("opc");

  // Global UE-AMBR template
  const [ueAmbr, setUeAmbr] = useState({ downlink: { unit: 3, value: 1 }, uplink: { unit: 3, value: 1 } });

  // 3-level nesting core: Slice -> Session -> PCC Rule
  const [slices, setSlices] = useState<any[]>([]);
  const [accessRestriction, setAccessRestriction] = useState<number>(0);

  // ======== OCS preset parameter template ========
  const [ratingList, setRatingList] = useState<any[]>([]);
  const [tariffPlanList, setTariffPlanList] = useState<Array<{ plan_id: string; name?: string; status?: string }>>([]);
  const [ocsDefaults, setOcsDefaults] = useState<any>({
    planId: "plan_default_10gb",
    trafficTotal: "10 GB",
    trafficBalance: "10 GB",
    smsTotal: "100",
    smsBalance: "100",
  });
  const draftSignature = useMemo(() => JSON.stringify({
    inputName,
    profileTitle,
    authData,
    usimType,
    ueAmbr,
    slices,
    accessRestriction,
    ocsDefaults,
  }), [inputName, profileTitle, authData, usimType, ueAmbr, slices, accessRestriction, ocsDefaults]);
  const initialDraftRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoading && initialDraftRef.current === null) initialDraftRef.current = draftSignature;
  }, [draftSignature, isLoading]);

  const checkUnsavedChanges = useCallback(() => isEditing
    && initialDraftRef.current !== null
    && initialDraftRef.current !== draftSignature, [draftSignature, isEditing]);
  const unsavedGuard = useUnsavedChangesGuard(checkUnsavedChanges, onClose);

  const applyProfileData = useCallback((p: any) => {
    setProfileSnapshot(p);
    setProfileTitle(p.title || profileName || "");
    if (p.auth) {
      const detected = p.auth.op ? "op" : "opc";
      setUsimType(detected);
      setAuthData({ k: p.auth.k || "", opValue: p.auth.opc || p.auth.op || "", amf: p.auth.amf || "8000" });
    }
    if (p.ambr) setUeAmbr(p.ambr);
    if (Array.isArray(p.sliceList)) setSlices(p.sliceList);
    if (p.access_restriction_data !== undefined) {
      setAccessRestriction(Number(p.access_restriction_data));
    }

    if (p.ocsDefaults) {
      const smsTotalDefault = p.ocsDefaults.smsTotal ?? p.ocsDefaults.sms_total;
      const smsBalanceDefault = p.ocsDefaults.smsBalance ?? p.ocsDefaults.sms_balance;
      const planDefault = p.ocsDefaults.planId ?? p.ocsDefaults.plan_id ?? p.ocsDefaults.planID;
      setOcsDefaults((prev: any) => ({
        ...prev,
        ...p.ocsDefaults,
        planId: planDefault !== undefined ? String(planDefault) : (prev.planId || "plan_default_10gb"),
        trafficTotal: p.ocsDefaults.trafficTotal !== undefined ? formatBytes(p.ocsDefaults.trafficTotal) : (p.ocsDefaults.trafficBalance !== undefined ? formatBytes(p.ocsDefaults.trafficBalance) : prev.trafficTotal),
        trafficBalance: p.ocsDefaults.trafficBalance !== undefined ? formatBytes(p.ocsDefaults.trafficBalance) : prev.trafficBalance,
        smsTotal: smsTotalDefault !== undefined ? formatEvents(Number(smsTotalDefault)) : (smsBalanceDefault !== undefined ? formatEvents(Number(smsBalanceDefault)) : prev.smsTotal),
        smsBalance: smsBalanceDefault !== undefined ? formatEvents(Number(smsBalanceDefault)) : prev.smsBalance,
      }));
    }
  }, [profileName]);

  const readError = async (res: Response, fallback: string) => {
    const data = await res.json().catch(() => ({}));
    if (data.error === "Invalid profile name format") return t("prof_err_name_invalid");
    if (data.error === "Profile with this name already exists") return t("prof_err_exists");
    return data.error || fallback;
  };

  const buildProfilePayload = (targetName: string) => {
    const authPayload: any = { k: authData.k, amf: authData.amf };
    authPayload[usimType] = authData.opValue;
    return {
      title: profileTitle || targetName,
      auth: authPayload,
      ambr: ueAmbr,
      access_restriction_data: accessRestriction,
      sliceList: slices,
      ocsDefaults: {
        planId: ocsDefaults.planId || "plan_default_10gb",
        trafficTotal: parseBytes(ocsDefaults.trafficTotal || ocsDefaults.trafficBalance),
        trafficBalance: parseBytes(ocsDefaults.trafficBalance),
        smsTotal: parseEvents(ocsDefaults.smsTotal || ocsDefaults.smsBalance),
        smsBalance: parseEvents(ocsDefaults.smsBalance),
      }
    };
  };

  const validateProfileDraft = (targetName: string) => {
    if (!targetName) throw new Error(t("prof_err_name_req"));
    for (const slice of slices || []) {
      for (const session of slice?.session_list || []) {
        const pgwIpv4 = String(session?.pgwIpv4 || "").trim();
        if (pgwIpv4 && !/^(\d{1,3}\.){3}\d{1,3}$/.test(pgwIpv4)) {
          throw new Error(t("prof_err_pgw_ipv4", { name: session?.name || "unknown" }));
        }
      }
    }
  };

  const getProfileDraftDiffRows = (draft: any): DraftDiffRow[] => {
    const current = profileSnapshot || {};
    const fields = [
      { key: "title", label: t("prof_title") },
      { key: "auth", label: t("sec_security_auth") },
      { key: "ambr", label: t("sec_global_network") },
      { key: "ocsDefaults", label: t("sec_billing_config") },
      { key: "access_restriction_data", label: t("sec_access_restrict") },
      { key: "sliceList", label: t("prof_sec_slices") },
    ];

    return fields.map(field => ({
      key: field.key,
      label: field.label,
      changed: JSON.stringify(current[field.key]) !== JSON.stringify(draft[field.key]),
    }));
  };

  const loadProfileData = useCallback(async () => {
    if (!profileName) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/profiles/${profileName}?t=${Date.now()}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      if (data.profile) applyProfileData(data.profile);
      if (data.stats && typeof data.stats.totalSubscribers === 'number') {
        setBackendStats(data.stats);
      }
    } catch {
      setError(t("prof_err_load"));
    } finally {
      setIsLoading(false);
    }
  }, [applyProfileData, profileName, t]);

  const loadVersions = useCallback(async () => {
    if (!profileName) return;
    setIsVersionsLoading(true);
    try {
      const res = await fetch(`/api/profiles/${profileName}/versions?limit=20&t=${Date.now()}`);
      if (!res.ok) throw new Error("Failed to fetch versions");
      const data = await res.json();
      setVersions(data.versions || []);
    } catch {
      setVersions([]);
    } finally {
      setIsVersionsLoading(false);
    }
  }, [profileName]);

  // Load available tariff plans
  useEffect(() => {
    fetch('/api/tariff-plans').then(r => r.json()).then(d => {
      const plans = Array.isArray(d.plans) ? d.plans : [];
      setTariffPlanList(plans);
      setOcsDefaults((current: any) => {
        if (plans.some((plan: any) => plan.plan_id === current.planId)) return current;
        return {
          ...current,
          planId: plans.find((plan: any) => (plan.status || "active") === "active")?.plan_id || plans[0]?.plan_id || current.planId || "plan_default_10gb",
        };
      });
    }).catch(() => {});
  }, []);

  // Load Rating Group list for the selected profile default plan
  useEffect(() => {
    const planId = ocsDefaults.planId || "plan_default_10gb";
    fetch(`/api/ratings?planId=${encodeURIComponent(planId)}`).then(r => r.json()).then(d => setRatingList(d.ratings || [])).catch(() => {});
  }, [ocsDefaults.planId]);

  /**
   * Load full Profile data from MongoDB.
   */
  useEffect(() => {
    if (!profileName) return;
    void Promise.resolve().then(() => {
      void loadProfileData();
      void loadVersions();
    });
  }, [loadProfileData, loadVersions, profileName]);

  /** Delete Profile */
  const handleDelete = () => {
    if (!profileName) return;
    setError(null);
    setForceDeleteCount(null);
    setIsDeleteConfirmOpen(true);
  };

  const executeDelete = async (force = false) => {
    if (!profileName) return;
    setIsDeleting(true);
    setError(null);
    try {
      const url = force ? `/api/profiles/${profileName}?force=true` : `/api/profiles/${profileName}`;
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) {
        if (res.status === 409) {
          const body = await res.json().catch(() => ({}));
          if (body.error === 'PROFILE_IN_USE') {
            setIsDeleteConfirmOpen(false);
            setForceDeleteCount(Number(body.subscriberCount || backendStats?.totalSubscribers || impactedSubscribers || 1));
            return;
          }
        }
        throw new Error(await readError(res, t("prof_err_delete")));
      }
      onRefresh();
      onOperation?.({ type: "success", text: t("prof_msg_deleted") });
      onClose();
    } catch (err: any) {
      const message = err.message || t("prof_err_delete");
      setError(message);
    } finally {
      setIsDeleting(false);
    }
  };

  const openVersion = async (versionId: string) => {
    if (!profileName) return;
    try {
      const res = await fetch(`/api/profiles/${profileName}/versions?versionId=${encodeURIComponent(versionId)}`);
      if (!res.ok) throw new Error("Failed to fetch version");
      const data = await res.json();
      setSelectedVersion(data.version || null);
      setRestoreConfirmVersionId(null);
    } catch {
      setError(t("prof_version_err_load"));
    }
  };

  const handleRestoreVersion = async () => {
    if (!profileName || !selectedVersion) return;
    if (restoreConfirmVersionId !== selectedVersion.versionId) {
      setRestoreConfirmVersionId(selectedVersion.versionId);
      return;
    }
    setIsRestoring(true);
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${profileName}/versions/${selectedVersion.versionId}/restore`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || t("prof_version_err_restore"));
      }
      if (data?.approval?.id) {
        setRestoreConfirmVersionId(null);
        onOperation?.({ type: "success", text: t("approval_msg_submitted", { id: data.approval.id }) });
        return;
      }
      await loadProfileData();
      await loadVersions();
      setSelectedVersion(null);
      setRestoreConfirmVersionId(null);
      setIsEditing(false);
      onRefresh();
      onOperation?.({ type: "success", text: t("prof_version_msg_restored") });
    } catch (err: any) {
      const message = err.message || t("prof_version_err_restore");
      setError(message);
    } finally {
      setIsRestoring(false);
    }
  };

  const formatVersionTime = (value: string) => {
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  };

  /**
   * Save Profile to MongoDB.
   */
  const submitProfile = async (targetName: string, payload: any) => {
    setIsSaving(true);
    try {
      //  Profile
      if (!profileName) {
        const createRes = await fetch("/api/profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: targetName }),
        });
        if (!createRes.ok) {
          throw new Error(await readError(createRes, t("prof_err_create")));
        }
      }

      const res = await fetch(`/api/profiles/${targetName}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(t("prof_err_save"));
      setIsSaveConfirmOpen(false);
      onRefresh();
      onOperation?.({ type: "success", text: t("prof_msg_saved") });
      onClose();
    } catch (err: any) {
      const message = err.message || t("sub_err_save");
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async () => {
    setError(null);
    try {
      const targetName = profileName || buildProfileKeyFromTitle(inputName || profileTitle);
      validateProfileDraft(targetName);
      const payload = buildProfilePayload(targetName);
      const changedRows = profileName ? getProfileDraftDiffRows(payload).filter(row => row.changed) : [];

      if (profileName && changedRows.length > 0 && !isSaveConfirmOpen) {
        setIsSaveConfirmOpen(true);
        return;
      }

      await submitProfile(targetName, payload);
    } catch (err: any) {
      const message = err.message || t("sub_err_save");
      setError(message);
    }
  };

  const handleConfirmSave = async () => {
    setError(null);
    try {
      const targetName = profileName || buildProfileKeyFromTitle(inputName || profileTitle);
      validateProfileDraft(targetName);
      await submitProfile(targetName, buildProfilePayload(targetName));
    } catch (err: any) {
      const message = err.message || t("sub_err_save");
      setError(message);
    }
  };

  // Smooth scrolling anchor navigation
  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // --- Level 1 Mutators ---
  const addSlice = () => {
    // Auto-increment SD by 1, padding to 6 digits
    const currentMaxSd = slices.reduce((max: number, slice: any) => {
      const parsed = parseInt(String(slice?.sd ?? "0"), 10);
      return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
    }, 0);
    const nextSd = String(Math.max(1, currentMaxSd + 1)).padStart(6, "0");
    const newIdx = slices.length;
    setSlices([...slices, { default_indicator: slices.length === 0, sd: nextSd, sst: 1, session_list: [] }]);
    setNewlyAddedSliceIndex(newIdx);
    setTimeout(() => setNewlyAddedSliceIndex(null), 1500);
    setTimeout(() => scrollTo(`pslice-card-${newIdx}`), 100);
  };
  const removeSlice = (i: number) => { const s = [...slices]; s.splice(i, 1); setSlices(s); };

  const handleSliceChange = (i: number, newSlice: any) => {
    const s = [...slices];
    s[i] = newSlice;
    setSlices(s);
  };

  const renderVersionHistory = () => {
    if (!profileName) return null;

    return (
      <div className="dash-card animate-fade-in pm-card" id="psec-versions">
        <div className="dash-card-header pm-card-header">
          <div className="pm-card-header-left">
            <History size={20} color="var(--primary)" />
            <div>
              <h3 className="pm-card-header-title">{t("prof_version_title")}</h3>
              <p className="pm-card-header-desc">
                {t("prof_version_desc")}
              </p>
            </div>
          </div>
          <button className="btn btn-outline pm-refresh-btn" onClick={loadVersions} disabled={isVersionsLoading}>
            {isVersionsLoading ? t("prof_version_loading") : t("audit_refresh")}
          </button>
        </div>
        <div className="dash-card-body pm-card-body">
          <div className="pm-versions-list">
            {versions.length === 0 ? (
              <div className="pm-versions-empty">
                {isVersionsLoading ? t("prof_version_loading") : t("prof_version_empty")}
              </div>
            ) : versions.map(version => (
              <button
                key={version.versionId}
                type="button"
                onClick={() => openVersion(version.versionId)}
                className={`pm-version-btn ${selectedVersion?.versionId === version.versionId ? "selected" : ""}`}
              >
                <div className="pm-version-btn-top">
                  <strong className="pm-version-btn-title">{t(`prof_version_action_${version.action}` as any)}</strong>
                  <span className="pm-version-btn-slices">{version.sliceCount} {t("prof_version_slices")}</span>
                </div>
                <div className="pm-version-btn-time">
                  {formatVersionTime(version.savedAt)}
                </div>
                <div className="pm-version-btn-by">
                  {t("prof_version_by")} {version.savedBy}
                </div>
              </button>
            ))}
          </div>

          <div className="pm-version-diff">
            {!selectedVersion ? (
              <div className="pm-version-diff-empty">
                {t("prof_version_select")}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div className="pm-version-diff-header">
                  <div>
                    <div className="pm-version-diff-title">
                      <GitCompareArrows size={16} color="var(--primary)" />
                      {t("prof_version_diff")}
                    </div>
                    <div className="pm-version-diff-meta">
                      {formatVersionTime(selectedVersion.savedAt)} · {selectedVersion.savedBy}
                    </div>
                  </div>
                  {(isRoot || isOperator) && (
                    <button className="btn btn-primary pm-restore-btn" onClick={handleRestoreVersion} disabled={isRestoring}>
                      <RotateCcw size={14} /> {isRestoring ? t("prof_version_restoring") : (restoreConfirmVersionId === selectedVersion.versionId ? t("prof_version_restore_confirm_btn") : t("prof_version_restore"))}
                    </button>
                  )}
                </div>
                <VisualDiffViewer
                  oldData={selectedVersion.profile}
                  newData={profileSnapshot}
                  title={`${selectedVersion.profile?.title || selectedVersion.profileName} (v)`}
                  defaultMode="semantic"
                  compact
                />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // --- View Mode: Profile static display ---
  const renderViewMode = () => {
    return <ProfileViewMode
      t={t}
      authData={authData}
      usimType={usimType}
      ocsDefaults={ocsDefaults}
      tariffPlanList={tariffPlanList}
      ratingList={ratingList}
      ueAmbr={ueAmbr}
      isAccessRestrictionsExpanded={isAccessRestrictionsExpanded}
      setIsAccessRestrictionsExpanded={setIsAccessRestrictionsExpanded}
      accessRestriction={accessRestriction}
      slices={slices}
      backendStats={backendStats}
    />;
  };

  // --- Edit Mode: Profile 3-level editor ---
  const renderEditMode = () => {
    return <ProfileEditMode
      t={t}
      profileName={profileName}
      state={{
        inputName, profileTitle, authData, usimType, ueAmbr, isAccessRestrictionsExpanded, accessRestriction,
        ocsDefaults, tariffPlanList, ratingList, slices, newlyAddedSliceIndex
      }}
      actions={{
        setInputName, setProfileTitle, setAuthData, setUsimType, setUeAmbr, setIsAccessRestrictionsExpanded, setAccessRestriction,
        setOcsDefaults, addSlice, handleSliceChange, removeSlice
      }}
    />;
  };

  const effectiveImpactedSubscribers = backendStats?.totalSubscribers ?? impactedSubscribers;
  const draftTargetName = (profileName || inputName || profileTitle).trim();
  const draftPayload = profileName && draftTargetName ? buildProfilePayload(draftTargetName) : null;
  const draftDiffRows = draftPayload ? getProfileDraftDiffRows(draftPayload) : [];
  const changedDraftRows = draftDiffRows.filter(row => row.changed);
  const changedSectionText = changedDraftRows.map(row => row.label).join(", ") || t("prof_change_none");

  // --- Root Return: Modal skeleton & sidebar ---
  return (
    <div className="modal-overlay" onClick={unsavedGuard.requestClose}>
      <div className="modal-content workflow-modal animate-modal-enter" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="workflow-header">
          <div className="workflow-title-group">
            <div>
              <h2 className="pm-wf-header-title">{profileName ? (profileTitle || profileName) : t("prof_new_profile")}</h2>
              {!profileName && <p className="pm-wf-header-desc">{t("prof_new_desc")}</p>}
            </div>
          </div>
          <div className="workflow-header-actions">
            {isRoot && !isEditing && (
              <button className="btn-icon" onClick={() => { setIsEditing(true); setIsSaveConfirmOpen(false); }} title={t("prof_btn_edit")}><Pencil size={24} color="var(--primary)" /></button>
            )}
            {isRoot && profileName && <button className="btn-icon" onClick={handleDelete} title={t("prof_btn_delete")} disabled={isDeleting || isDeleteConfirmOpen || forceDeleteCount !== null}><Trash2 size={24} color="var(--danger)" /></button>}
            <div className="pm-wf-header-divider" />
            <button className="btn-icon" onClick={unsavedGuard.requestClose} title={t("close")}><X size={26} color="var(--text-muted)" /></button>
          </div>
        </div>

        {isDeleteConfirmOpen && (
          <div className="pm-confirm-panel">
            <ConfirmActionPanel
              presentation="modal"
              title={t("prof_del_confirm", { name: profileName || "" })}
              message={t("prof_del_desc")}
              confirmLabel={t("delete")}
              cancelLabel={t("cancel")}
              isWorking={isDeleting}
              onConfirm={() => executeDelete(false)}
              onCancel={() => setIsDeleteConfirmOpen(false)}
            />
          </div>
        )}

        {forceDeleteCount !== null && (
          <div className="pm-confirm-panel">
            <ConfirmActionPanel
              presentation="modal"
              tone="danger"
              title={t("prof_del_in_use_title", { name: profileName || "" })}
              message={t("prof_del_in_use_desc", { count: forceDeleteCount, name: profileName || "" })}
              confirmLabel={t("prof_btn_force_delete")}
              cancelLabel={t("cancel")}
              isWorking={isDeleting}
              onConfirm={() => executeDelete(true)}
              onCancel={() => setForceDeleteCount(null)}
            />
          </div>
        )}

        {isSaveConfirmOpen && (
          <div className="pm-confirm-panel">
            <ConfirmActionPanel
              presentation="modal"
              tone={effectiveImpactedSubscribers > 0 ? "warning" : "info"}
              title={t("prof_change_confirm_title")}
              message={t("prof_change_confirm_desc", { count: effectiveImpactedSubscribers, sections: changedSectionText })}
              confirmLabel={t("prof_change_confirm_btn")}
              cancelLabel={t("cancel")}
              isWorking={isSaving}
              onConfirm={handleConfirmSave}
              onCancel={() => setIsSaveConfirmOpen(false)}
            />
            <div
              className="pm-confirm-stats"
            >
              <div className="pm-confirm-stats-grid">
                <div className="pm-confirm-stat-card">
                  <div className="table-header-cap pm-confirm-stat-label">{t("prof_change_impacted")}</div>
                  <div className={`pm-confirm-stat-value ${effectiveImpactedSubscribers > 0 ? "warning" : "success"}`}>
                    {effectiveImpactedSubscribers}
                  </div>
                </div>
                <div className="pm-confirm-stat-card">
                  <div className="table-header-cap pm-confirm-stat-label">{t("prof_change_sections")}</div>
                  <div className="pm-confirm-stat-value main">
                    {changedDraftRows.length}
                  </div>
                </div>
              </div>
              <div className="pm-confirm-diff-rows">
                {draftDiffRows.map(row => (
                  <div key={row.key} className="pm-confirm-diff-row">
                    <span className="pm-diff-label">{row.label}</span>
                    <strong className={row.changed ? "pm-confirm-diff-changed" : "pm-confirm-diff-unchanged"}>
                      {row.changed ? t("prof_version_changed") : t("prof_version_unchanged")}
                    </strong>
                  </div>
                ))}
              </div>
              <div className="pm-confirm-note">
                {t("prof_change_confirm_note")}
              </div>
            </div>
          </div>
        )}

        {/* Body: Left TOC + Right Content */}
        <div className="workflow-body">
          <div className="workflow-sidebar">
            <h4 className="pm-toc-title">{t("sections")}</h4>
            {isEditing && (
              <button className="workflow-step" onClick={() => scrollTo('psec-info')}>
                <span className="workflow-step-index">1</span>
                <span className="workflow-step-label"><strong>{t("prof_sec_info")}</strong><span>{t("prof_sec_info_desc")}</span></span>
              </button>
            )}
            {profileName && (
              <button className="workflow-step" onClick={() => scrollTo('psec-versions')}>
                <span className="workflow-step-index">V</span>
                <span className="workflow-step-label"><strong>{t("prof_version_nav")}</strong><span>{t("prof_version_nav_desc")}</span></span>
              </button>
            )}
            <button className="workflow-step" onClick={() => scrollTo('psec-security')}>
              <span className="workflow-step-index">{isEditing ? "2" : "1"}</span>
              <span className="workflow-step-label"><strong>{t("sec_security_auth")}</strong><span>{t("prof_sec_security_desc")}</span></span>
            </button>
            <button className="workflow-step" onClick={() => scrollTo(isEditing ? 'psec-ocs-edit' : 'psec-ocs-view')}>
              <span className="workflow-step-index">{isEditing ? "3" : "2"}</span>
              <span className="workflow-step-label"><strong>{t("prof_sec_billing")}</strong><span>{t("prof_sec_billing_desc")}</span></span>
            </button>
            <button className="workflow-step" onClick={() => scrollTo('psec-network')}>
              <span className="workflow-step-index">{isEditing ? "4" : "3"}</span>
              <span className="workflow-step-label"><strong>{t("prof_sec_network")}</strong><span>{t("prof_sec_network_desc")}</span></span>
            </button>
            <button className="workflow-step" onClick={() => scrollTo('psec-access-restrictions')}>
              <span className="workflow-step-index">{isEditing ? "5" : "4"}</span>
              <span className="workflow-step-label"><strong>{t("prof_sec_access")}</strong><span>{t("prof_sec_access_desc")}</span></span>
            </button>
            <button className="workflow-step" onClick={() => scrollTo('psec-slices')}>
              <span className="workflow-step-index">{isEditing ? "6" : "5"}</span>
              <span className="workflow-step-label"><strong>{t("prof_sec_slices")}</strong><span>{t("prof_sec_slices_desc")}</span></span>
            </button>
          </div>

          <div className="workflow-content">
            {error && (
              <OperationNotice
                presentation="modal"
                tone="danger"
                title={t("error")}
                message={error}
                onClose={() => setError(null)}
              />
            )}
            {isLoading ? (
              <LoadingRows columns={4} rows={4} />
            ) : (
              <div className="workflow-content-inner">
                {renderVersionHistory()}
                {isEditing ? renderEditMode() : renderViewMode()}
              </div>
            )}
          </div>
        </div>
        <div className="workflow-footer">
          <div className="pm-wf-footer-text">
            {isEditing ? t("prof_msg_edit") : t("prof_msg_view")}
          </div>
          <div className="workflow-footer-actions">
            <button className="btn btn-outline" onClick={unsavedGuard.requestClose}>{t("cancel")}</button>
            {isEditing ? (
              <button className="btn btn-primary" onClick={handleSave} disabled={isSaving || (!profileName && !(inputName || profileTitle).trim())}>
                <Save size={16}/> {isSaving ? t("sub_btn_saving") : (profileName ? t("prof_btn_save") : t("prof_btn_create"))}
              </button>
            ) : isRoot ? (
              <button className="btn btn-primary" onClick={() => { setIsEditing(true); setIsSaveConfirmOpen(false); }}>
                <Pencil size={16}/> {t("prof_btn_edit")}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <UnsavedChangesDialog
        open={unsavedGuard.isPromptOpen}
        title={t("unsaved_changes_title")}
        description={t("unsaved_changes_description")}
        keepEditingLabel={t("unsaved_changes_keep_editing")}
        discardLabel={t("unsaved_changes_discard")}
        onKeepEditing={unsavedGuard.keepEditing}
        onDiscard={unsavedGuard.discardChanges}
      />
    </div>
  );
}
