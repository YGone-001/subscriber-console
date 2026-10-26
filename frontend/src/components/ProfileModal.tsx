/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ProfileModal.tsx
 * Adaptations: `@/` aliases and CSS-module imports repointed; the retired visual-diff viewer is not ported, so its version-compare affordance is removed rather than left dead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from '../providers/I18nProvider';
import { Save, Trash2, X, Pencil, History, RotateCcw, GitCompareArrows } from "lucide-react";
import { parseBytes, formatBytes, parseEvents, formatEvents } from '../lib/unitParser';
import ProfileViewMode from '../features/profiles/components/ProfileViewMode';
import ProfileEditMode from '../features/profiles/components/ProfileEditMode';
import { buildProfileVersionDiff } from '../features/profiles/profile-version-diff';
import { findProfileDraftIssue } from '../features/profiles/profile-validation';
import { useAuth } from '../providers/AuthProvider';
import { hasPermission } from '../lib/permissions';
import { ConfirmActionPanel, LoadingRows, OperationNotice } from './ui/OperationFeedback';
import { ErrorState } from './ui/StatePanel';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from './ui/UnsavedChangesGuard';
import { Dialog } from './ui/Dialog';

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

const OCS_EDITABLE_KEYS = ['planId', 'trafficTotal', 'trafficBalance', 'smsTotal', 'smsBalance'];

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
  const { t, formatDateTime } = useI18n();
  const { user: currentUser } = useAuth();
  /* The historical hook exposed the two governance roles directly; the current
   * session provider exposes the account, so the roles are derived from it. */
  const isRoot = hasPermission(currentUser, 'profiles.write');
  const isOperator = isRoot;
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
  const [isVersionDetailLoading, setIsVersionDetailLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<ProfileVersionDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tariffPlanStatus, setTariffPlanStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [ratingStatus, setRatingStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Blinking animation state flag
  const [newlyAddedSliceIndex, setNewlyAddedSliceIndex] = useState<number | null>(null);

  // Profile basic info
  const [inputName, setInputName] = useState(profileName || "");
  const [profileTitle, setProfileTitle] = useState("");

  // Auth template fields
  const [authData, setAuthData] = useState({ k: "", opValue: "", amf: "" });
  // USIM type selection: determines opc or op key
  const [usimType, setUsimType] = useState<"opc" | "op">("opc");

  // Global UE-AMBR template. Empty until the template declares one.
  const [ueAmbr, setUeAmbr] = useState<{ downlink: { unit?: number; value?: number }; uplink: { unit?: number; value?: number } }>({
    downlink: {},
    uplink: {},
  });

  // 3-level nesting core: Slice -> Session -> PCC Rule
  const [slices, setSlices] = useState<any[]>([]);
  const [accessRestriction, setAccessRestriction] = useState<number | null>(null);

  // ======== OCS preset parameter template ========
  const [ratingList, setRatingList] = useState<any[]>([]);
  const [tariffPlanList, setTariffPlanList] = useState<Array<{ plan_id: string; name?: string; status?: string }>>([]);
  const [ocsDefaults, setOcsDefaults] = useState<any>({
    planId: "",
    trafficTotal: "",
    trafficBalance: "",
    smsTotal: "",
    smsBalance: "",
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
      setAuthData({ k: p.auth.k || "", opValue: p.auth.opc || p.auth.op || "", amf: p.auth.amf || "" });
    }
    if (p.ambr) setUeAmbr(p.ambr);
    if (Array.isArray(p.sliceList)) setSlices(p.sliceList);
    if (p.access_restriction_data !== undefined) {
      setAccessRestriction(Number(p.access_restriction_data));
    }

    /* Clear first so a template without billing defaults never inherits the
     * previously displayed values. */
    setOcsDefaults({ planId: "", trafficTotal: "", trafficBalance: "", smsTotal: "", smsBalance: "" });
    if (p.ocsDefaults) {
      const smsTotalDefault = p.ocsDefaults.smsTotal ?? p.ocsDefaults.sms_total;
      const smsBalanceDefault = p.ocsDefaults.smsBalance ?? p.ocsDefaults.sms_balance;
      const planDefault = p.ocsDefaults.planId ?? p.ocsDefaults.plan_id ?? p.ocsDefaults.planID;
      setOcsDefaults((prev: any) => ({
        ...prev,
        ...p.ocsDefaults,
        planId: planDefault !== undefined ? String(planDefault) : (prev.planId || ""),
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

  const buildOcsDefaultsPayload = () => {
    const payload: Record<string, unknown> = {};
    /* Keep stored keys this form does not edit (voice, PLMN, ...). */
    for (const [key, value] of Object.entries(ocsDefaults)) {
      if (!OCS_EDITABLE_KEYS.includes(key)) payload[key] = value;
    }
    delete payload.plan_id;
    delete payload.planID;
    delete payload.sms_total;
    delete payload.sms_balance;

    const planId = String(ocsDefaults.planId ?? "").trim();
    if (planId) payload.planId = planId;
    const trafficTotal = String(ocsDefaults.trafficTotal ?? "").trim();
    if (trafficTotal) payload.trafficTotal = parseBytes(trafficTotal);
    const trafficBalance = String(ocsDefaults.trafficBalance ?? "").trim();
    if (trafficBalance) payload.trafficBalance = parseBytes(trafficBalance);
    const smsTotal = String(ocsDefaults.smsTotal ?? "").trim();
    if (smsTotal) payload.smsTotal = parseEvents(smsTotal);
    const smsBalance = String(ocsDefaults.smsBalance ?? "").trim();
    if (smsBalance) payload.smsBalance = parseEvents(smsBalance);
    return payload;
  };

  const buildProfilePayload = (targetName: string) => {
    const authPayload: any = { k: authData.k, amf: authData.amf };
    authPayload[usimType] = authData.opValue;
    const body: any = {
      title: profileTitle || targetName,
      auth: authPayload,
      ambr: ueAmbr,
      sliceList: slices,
    };
    if (typeof accessRestriction === "number") {
      body.access_restriction_data = accessRestriction;
    }
    const ocsPayload = buildOcsDefaultsPayload();
    if (Object.keys(ocsPayload).length > 0) {
      body.ocsDefaults = ocsPayload;
    } else if (profileSnapshot?.ocsDefaults) {
      /* An explicit clear: the operator removed every billing default. */
      body.ocsDefaults = {};
    }
    return body;
  };

  const validateProfileDraft = (targetName: string) => {
    const issue = findProfileDraftIssue({ name: targetName, auth: authData, ambr: ueAmbr, slices });
    if (!issue) return;
    switch (issue.code) {
      case 'nameRequired':
        throw new Error(t("prof_err_name_req"));
      case 'kFormat':
        throw new Error(t("prof_err_k_format"));
      case 'opFormat':
        throw new Error(t("prof_err_op_format"));
      case 'amfFormat':
        throw new Error(t("prof_err_amf_format"));
      case 'ambrInvalid':
        throw new Error(t("prof_err_ambr_invalid", { direction: t(issue.direction === "downlink" ? "sub_dl" : "sub_ul") }));
      case 'sstRange':
        throw new Error(t("prof_err_sst_range", { index: issue.index }));
      case 'sdFormat':
        throw new Error(t("prof_err_sd_format", { index: issue.index }));
      case 'pgwIpv4':
        throw new Error(t("prof_err_pgw_ipv4", { name: issue.sessionName }));
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
    setLoadFailed(false);
    try {
      const res = await fetch(`/api/profiles/${profileName}?t=${Date.now()}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      if (!data.profile) throw new Error("Missing profile payload");
      applyProfileData(data.profile);
      if (data.stats && typeof data.stats.totalSubscribers === 'number') {
        setBackendStats(data.stats);
      }
    } catch {
      setLoadFailed(true);
    } finally {
      setIsLoading(false);
    }
  }, [applyProfileData, profileName]);

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

  // Load available tariff plans. A failed list is reported as unavailable, and
  // never replaced by a default plan id or an invented fallback option.
  useEffect(() => {
    let cancelled = false;
    setTariffPlanStatus('loading');
    fetch('/api/tariff-plans')
      .then(response => {
        if (!response.ok) throw new Error('tariff plans unavailable');
        return response.json();
      })
      .then(data => {
        if (cancelled) return;
        setTariffPlanList(Array.isArray(data.plans) ? data.plans : []);
        setTariffPlanStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setTariffPlanList([]);
        setTariffPlanStatus('unavailable');
      });
    return () => { cancelled = true; };
  }, []);

  // Load the rating rules of the selected plan, if any.
  useEffect(() => {
    const planId = String(ocsDefaults.planId || '').trim();
    if (!planId) {
      setRatingList([]);
      setRatingStatus('ready');
      return;
    }
    let cancelled = false;
    setRatingStatus('loading');
    fetch(`/api/ratings?planId=${encodeURIComponent(planId)}`)
      .then(response => {
        if (!response.ok) throw new Error('rating rules unavailable');
        return response.json();
      })
      .then(data => {
        if (cancelled) return;
        setRatingList(Array.isArray(data.ratings) ? data.ratings : []);
        setRatingStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setRatingList([]);
        setRatingStatus('unavailable');
      });
    return () => { cancelled = true; };
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
    setIsVersionDetailLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${profileName}/versions?versionId=${encodeURIComponent(versionId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.version) throw new Error(data.error || t("prof_version_err_load"));
      setSelectedVersion(data.version);
    } catch (err: any) {
      setSelectedVersion(null);
      setError(err?.message || t("prof_version_err_load"));
    } finally {
      setIsVersionDetailLoading(false);
    }
  };

  const handleRestoreVersion = async () => {
    if (!profileName || !restoreTarget) return;
    setIsRestoring(true);
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${profileName}/versions/${restoreTarget.versionId}/restore`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || t("prof_version_err_restore"));
      }
      /* Direct execution: the restore has already been applied when this resolves,
       * so there is no pending-review state to report. */
      await loadProfileData();
      await loadVersions();
      setSelectedVersion(null);
      setRestoreTarget(null);
      setIsEditing(false);
      onRefresh();
      onOperation?.({ type: "success", text: t("prof_version_msg_restored") });
    } catch (err: any) {
      setRestoreTarget(null);
      setError(err?.message || t("prof_version_err_restore"));
    } finally {
      setIsRestoring(false);
    }
  };

  const formatVersionTime = (value: string) => formatDateTime(value);

  /**
   * Save Profile to MongoDB.
   */
  const submitProfile = async (targetName: string, payload: any) => {
    setIsSaving(true);
    const isCreate = !profileName;
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

      if (!res.ok) {
        const detail = await readError(res, t("prof_err_save"));
        throw new Error(isCreate ? t("prof_err_create_partial", { detail }) : detail);
      }
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

  const versionDiffSections = useMemo(() => {
    if (!selectedVersion) return [];
    return buildProfileVersionDiff(selectedVersion.profile, profileSnapshot, {
      notConfigured: t("prof_diff_not_configured"),
      sliceUnit: t("prof_version_slices"),
      sessionUnit: t("prof_diff_session_unit"),
      pccUnit: t("prof_diff_pcc_unit"),
      accessNone: t("prof_diff_access_none"),
      accessSuspended: t("prof_diff_access_suspended"),
      maskedSecret: t("prof_diff_masked"),
    });
  }, [profileSnapshot, selectedVersion, t]);
  const changedSectionCount = versionDiffSections.filter(section => section.changed).length;

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
                {isVersionDetailLoading ? t("prof_version_loading") : t("prof_version_select")}
              </div>
            ) : (
              <div className="pm-version-diff-body">
                <div className="pm-version-diff-header">
                  <div>
                    <div className="pm-version-diff-title">
                      <GitCompareArrows size={16} color="var(--primary)" />
                      {t("prof_version_diff")}
                    </div>
                    <div className="pm-version-diff-meta">
                      {t(`prof_version_action_${selectedVersion.action}` as any)} · {formatVersionTime(selectedVersion.savedAt)} · {selectedVersion.savedBy}
                    </div>
                  </div>
                  {(isRoot || isOperator) && (
                    <button className="btn btn-primary pm-restore-btn" onClick={() => setRestoreTarget(selectedVersion)} disabled={isRestoring}>
                      <RotateCcw size={14} /> {isRestoring ? t("prof_version_restoring") : t("prof_version_restore")}
                    </button>
                  )}
                </div>
                {changedSectionCount === 0 ? (
                  <p className="pm-diff-summary-note">{t("prof_version_no_changes")}</p>
                ) : (
                  <div className="pm-version-diff-sections">
                    <div className="pm-diff-columns" aria-hidden="true">
                      <span />
                      <span>{t("prof_diff_version_col")}</span>
                      <span>{t("prof_diff_current_col")}</span>
                    </div>
                    {versionDiffSections.map(section => (
                      <details key={section.key} className={`pm-diff-section ${section.changed ? "changed" : ""}`} open={section.changed}>
                        <summary>
                          <span className="pm-diff-section-title">{t(section.labelKey)}</span>
                          <strong className={section.changed ? "pm-confirm-diff-changed" : "pm-confirm-diff-unchanged"}>
                            {section.changed ? t("prof_version_changed") : t("prof_version_unchanged")}
                          </strong>
                        </summary>
                        <div className="pm-diff-rows">
                          {section.rows.map(row => (
                            <div key={row.key} className={`pm-diff-row ${row.changed ? "changed" : ""}`}>
                              <span className="pm-diff-row-label">{row.labelParams ? t(row.labelKey, row.labelParams) : t(row.labelKey)}</span>
                              <span className="pm-diff-row-value">{row.versionValue}</span>
                              <span className="pm-diff-row-value">{row.currentValue}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    ))}
                  </div>
                )}
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
      ratingStatus={ratingStatus}
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
        ocsDefaults, tariffPlanList, ratingList, tariffPlanStatus, ratingStatus, slices, newlyAddedSliceIndex
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
    <>
      <Dialog
        open
        onClose={unsavedGuard.requestClose}
        overlayClassName="modal-overlay"
        className="modal-content workflow-modal animate-modal-enter"
        labelledBy="profile-modal-title"
        initialFocusRef={closeButtonRef}
      >

        {/* Header */}
        <div className="workflow-header">
          <div className="workflow-title-group">
            <div>
              <h2 id="profile-modal-title" className="pm-wf-header-title">{profileName ? (profileTitle || profileName) : t("prof_new_profile")}</h2>
              {!profileName && <p className="pm-wf-header-desc">{t("prof_new_desc")}</p>}
            </div>
          </div>
          <div className="workflow-header-actions">
            {isRoot && !isEditing && !loadFailed && (
              <button className="btn-icon" onClick={() => { setIsEditing(true); setIsSaveConfirmOpen(false); }} title={t("prof_btn_edit")}><Pencil size={24} color="var(--primary)" /></button>
            )}
            {isRoot && profileName && !loadFailed && <button className="btn-icon" onClick={handleDelete} title={t("prof_btn_delete")} disabled={isDeleting || isDeleteConfirmOpen || forceDeleteCount !== null}><Trash2 size={24} color="var(--danger)" /></button>}
            <div className="pm-wf-header-divider" />
            <button ref={closeButtonRef} className="btn-icon" onClick={unsavedGuard.requestClose} title={t("close")} aria-label={t("close")}><X size={26} color="var(--text-muted)" /></button>
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

        {restoreTarget && (
          <div className="pm-confirm-panel">
            <ConfirmActionPanel
              presentation="modal"
              tone="warning"
              title={t("prof_version_restore_confirm_title", { name: profileName || "" })}
              message={t("prof_version_restore_confirm_desc", {
                action: t(`prof_version_action_${restoreTarget.action}` as any),
                time: formatVersionTime(restoreTarget.savedAt),
              })}
              confirmLabel={t("prof_version_restore_confirm_btn")}
              cancelLabel={t("cancel")}
              isWorking={isRestoring}
              onConfirm={handleRestoreVersion}
              onCancel={() => setRestoreTarget(null)}
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
          {!loadFailed && (
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
          )}

          <div className="workflow-content">
            {/*
              * Modal so the save outcome is visible from the bottom of a long form, but
              * suppressed while one of this dialog's own confirmations is open: the
              * notice portals above the confirmation and would make its buttons
              * unreachable, which is the exact failure the confirm dialog must not have.
              */}
            {error && !isDeleteConfirmOpen && forceDeleteCount === null && !restoreTarget && !isSaveConfirmOpen && (
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
            ) : loadFailed ? (
              <ErrorState
                title={t("prof_err_load")}
                message={t("prof_err_load_hint")}
                retryLabel={t("retry")}
                onRetry={() => { void loadProfileData(); void loadVersions(); }}
              />
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
            ) : isRoot && !loadFailed ? (
              <button className="btn btn-primary" onClick={() => { setIsEditing(true); setIsSaveConfirmOpen(false); }}>
                <Pencil size={16}/> {t("prof_btn_edit")}
              </button>
            ) : null}
          </div>
        </div>
      </Dialog>
      <UnsavedChangesDialog
        open={unsavedGuard.isPromptOpen}
        title={t("unsaved_changes_title")}
        description={t("unsaved_changes_description")}
        keepEditingLabel={t("unsaved_changes_keep_editing")}
        discardLabel={t("unsaved_changes_discard")}
        onKeepEditing={unsavedGuard.keepEditing}
        onDiscard={unsavedGuard.discardChanges}
      />
    </>
  );
}
