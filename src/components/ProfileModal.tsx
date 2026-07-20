"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "./I18nProvider";
import { Save, Trash2, X, Pencil, History, RotateCcw, GitCompareArrows } from "lucide-react";
import { parseBytes, formatBytes } from "@/lib/unitParser";
import ProfileViewMode from "./profile/ProfileViewMode";
import ProfileEditMode from "./profile/ProfileEditMode";
import { useAuth } from "@/hooks/useAuth";
import { ConfirmActionPanel, LoadingRows, OperationNotice } from "./OperationFeedback";

// Session type mapping (IPv4/IPv6/IPv4v6)
interface ProfileModalProps {
  profileName: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onOperation?: (notice: { type: "success" | "error"; text: string }) => void;
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

export default function ProfileModal({ profileName, onClose, onRefresh, onOperation }: ProfileModalProps) {
  const { t } = useI18n();
  const { isRoot } = useAuth();
  const [isEditing, setIsEditing] = useState(!profileName);
  const [isLoading, setIsLoading] = useState(!!profileName);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isAccessRestrictionsExpanded, setIsAccessRestrictionsExpanded] = useState(false);
  const [profileSnapshot, setProfileSnapshot] = useState<any>(null);
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
  const [ocsDefaults, setOcsDefaults] = useState<any>({
    trafficTotal: "10 GB",
    trafficBalance: "10 GB",
  });

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
      setOcsDefaults((prev: any) => ({
        ...prev,
        ...p.ocsDefaults,
        trafficTotal: p.ocsDefaults.trafficTotal !== undefined ? formatBytes(p.ocsDefaults.trafficTotal) : (p.ocsDefaults.trafficBalance !== undefined ? formatBytes(p.ocsDefaults.trafficBalance) : prev.trafficTotal),
        trafficBalance: p.ocsDefaults.trafficBalance !== undefined ? formatBytes(p.ocsDefaults.trafficBalance) : prev.trafficBalance,
      }));
    }
  }, [profileName]);

  const readError = async (res: Response, fallback: string) => {
    const data = await res.json().catch(() => ({}));
    return data.error || fallback;
  };

  const loadProfileData = useCallback(async () => {
    if (!profileName) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/profiles/${profileName}?t=${Date.now()}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      if (data.profile) applyProfileData(data.profile);
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

  // Load available Rating Group list
  useEffect(() => {
    fetch('/api/ratings').then(r => r.json()).then(d => setRatingList(d.ratings || [])).catch(() => {});
  }, []);

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
    setIsDeleteConfirmOpen(true);
  };

  const executeDelete = async () => {
    if (!profileName) return;
    setIsDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${profileName}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error(await readError(res, t("prof_err_delete")));
      }
      onRefresh();
      onOperation?.({ type: "success", text: t("prof_msg_deleted") });
      onClose();
    } catch (err: any) {
      const message = err.message || t("prof_err_delete");
      setError(message);
      onOperation?.({ type: "error", text: message });
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
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t("prof_version_err_restore"));
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
      onOperation?.({ type: "error", text: message });
    } finally {
      setIsRestoring(false);
    }
  };

  const getVersionDiffRows = () => {
    if (!selectedVersion) return [];
    const current = profileSnapshot || {};
    const previous = selectedVersion.profile || {};
    const fields = [
      { key: "title", label: t("prof_title") },
      { key: "auth", label: t("sec_security_auth") },
      { key: "ambr", label: t("sec_global_network") },
      { key: "ocsDefaults", label: t("sec_billing_config") },
      { key: "access_restriction_data", label: t("sec_access_restrict") },
      { key: "sliceList", label: t("prof_sec_slices") },
    ];

    return fields.map(field => {
      const oldValue = previous[field.key];
      const newValue = current[field.key];
      return {
        key: field.key,
        label: field.label,
        changed: JSON.stringify(oldValue) !== JSON.stringify(newValue),
      };
    });
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
  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const targetName = profileName || inputName;
      if (!targetName) throw new Error(t("prof_err_name_req"));
      for (const slice of slices || []) {
        for (const session of slice?.session_list || []) {
          const pgwIpv4 = String(session?.pgwIpv4 || "").trim();
          if (pgwIpv4 && !/^(\d{1,3}\.){3}\d{1,3}$/.test(pgwIpv4)) {
            throw new Error(t("prof_err_pgw_ipv4", { name: session?.name || "unknown" }));
          }
        }
      }

      //  Profile
      if (!profileName) {
        const createRes = await fetch("/api/profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: targetName }),
        });
        if (!createRes.ok) {
          const errData = await createRes.json();
          throw new Error(errData.error || t("prof_err_create"));
        }
      }

      // Construct payload
      const authPayload: any = { k: authData.k, amf: authData.amf };
      authPayload[usimType] = authData.opValue;
      const payload = {
        title: profileTitle || targetName,
        auth: authPayload,
        ambr: ueAmbr,
        access_restriction_data: accessRestriction,
        sliceList: slices,
        ocsDefaults: {
          trafficTotal: parseBytes(ocsDefaults.trafficTotal || ocsDefaults.trafficBalance),
          trafficBalance: parseBytes(ocsDefaults.trafficBalance),
        }
      };

      const res = await fetch(`/api/profiles/${targetName}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(t("prof_err_save"));
      onRefresh();
      onOperation?.({ type: "success", text: t("prof_msg_saved") });
      onClose();
    } catch (err: any) {
      const message = err.message || t("sub_err_save");
      setError(message);
      onOperation?.({ type: "error", text: message });
    } finally {
      setIsSaving(false);
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
    const diffRows = getVersionDiffRows();

    return (
      <div className="dash-card animate-fade-in" id="psec-versions" style={{ marginBottom: "1.5rem" }}>
        <div className="dash-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <History size={20} color="var(--primary)" />
            <div>
              <h3 style={{ margin: 0, fontSize: "1rem" }}>{t("prof_version_title")}</h3>
              <p style={{ margin: "0.25rem 0 0", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                {t("prof_version_desc")}
              </p>
            </div>
          </div>
          <button className="btn btn-outline" onClick={loadVersions} disabled={isVersionsLoading} style={{ padding: "0.45rem 0.8rem", fontSize: "0.82rem" }}>
            {isVersionsLoading ? t("prof_version_loading") : t("audit_refresh")}
          </button>
        </div>
        <div className="dash-card-body" style={{ display: "grid", gridTemplateColumns: "minmax(260px, 0.9fr) minmax(320px, 1.1fr)", gap: "1rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem", maxHeight: "360px", overflowY: "auto", paddingRight: "0.25rem" }}>
            {versions.length === 0 ? (
              <div style={{ padding: "1rem", color: "var(--text-muted)", border: "1px dashed var(--surface-border)", borderRadius: "8px" }}>
                {isVersionsLoading ? t("prof_version_loading") : t("prof_version_empty")}
              </div>
            ) : versions.map(version => (
              <button
                key={version.versionId}
                type="button"
                onClick={() => openVersion(version.versionId)}
                style={{
                  textAlign: "left",
                  border: selectedVersion?.versionId === version.versionId ? "1px solid var(--primary)" : "1px solid var(--surface-border)",
                  background: selectedVersion?.versionId === version.versionId ? "rgba(59, 130, 246, 0.08)" : "var(--surface)",
                  borderRadius: "8px",
                  padding: "0.8rem",
                  cursor: "pointer",
                  color: "var(--text-main)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center" }}>
                  <strong style={{ fontSize: "0.9rem" }}>{t(`prof_version_action_${version.action}` as any)}</strong>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{version.sliceCount} {t("prof_version_slices")}</span>
                </div>
                <div style={{ marginTop: "0.4rem", color: "var(--text-muted)", fontSize: "0.78rem" }}>
                  {formatVersionTime(version.savedAt)}
                </div>
                <div style={{ marginTop: "0.25rem", color: "var(--text-secondary)", fontSize: "0.78rem" }}>
                  {t("prof_version_by")} {version.savedBy}
                </div>
              </button>
            ))}
          </div>

          <div style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", padding: "1rem", minHeight: "220px", background: "var(--surface)" }}>
            {!selectedVersion ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", textAlign: "center" }}>
                {t("prof_version_select")}
              </div>
            ) : (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", marginBottom: "1rem" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700 }}>
                      <GitCompareArrows size={16} color="var(--primary)" />
                      {t("prof_version_diff")}
                    </div>
                    <div style={{ marginTop: "0.35rem", color: "var(--text-muted)", fontSize: "0.8rem" }}>
                      {formatVersionTime(selectedVersion.savedAt)} · {selectedVersion.savedBy}
                    </div>
                  </div>
                  {isRoot && (
                    <button className="btn btn-primary" onClick={handleRestoreVersion} disabled={isRestoring} style={{ padding: "0.55rem 0.85rem", fontSize: "0.82rem", whiteSpace: "nowrap" }}>
                      <RotateCcw size={14} /> {isRestoring ? t("prof_version_restoring") : (restoreConfirmVersionId === selectedVersion.versionId ? t("prof_version_restore_confirm_btn") : t("prof_version_restore"))}
                    </button>
                  )}
                </div>
                <div style={{ display: "grid", gap: "0.5rem" }}>
                  {diffRows.map(row => (
                    <div key={row.key} style={{ display: "flex", justifyContent: "space-between", gap: "1rem", borderBottom: "1px solid var(--surface-border)", padding: "0.55rem 0" }}>
                      <span style={{ color: "var(--text-secondary)" }}>{row.label}</span>
                      <span style={{ color: row.changed ? "var(--warning)" : "var(--success)", fontWeight: 700 }}>
                        {row.changed ? t("prof_version_changed") : t("prof_version_unchanged")}
                      </span>
                    </div>
                  ))}
                </div>
                <pre style={{ marginTop: "1rem", maxHeight: "140px", overflow: "auto", background: "rgba(0,0,0,0.05)", borderRadius: "8px", padding: "0.75rem", fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                  {JSON.stringify({
                    title: selectedVersion.profile?.title,
                    updatedAt: selectedVersion.profile?.updatedAt || selectedVersion.profile?.createdAt,
                    restoredFromVersionId: selectedVersion.profile?.restoredFromVersionId || null,
                  }, null, 2)}
                </pre>
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
      ratingList={ratingList}
      ueAmbr={ueAmbr}
      isAccessRestrictionsExpanded={isAccessRestrictionsExpanded}
      setIsAccessRestrictionsExpanded={setIsAccessRestrictionsExpanded}
      accessRestriction={accessRestriction}
      slices={slices}
    />;
  };

  // --- Edit Mode: Profile 3-level editor ---
  const renderEditMode = () => {
    return <ProfileEditMode
      t={t}
      profileName={profileName}
      state={{
        inputName, profileTitle, authData, usimType, ueAmbr, isAccessRestrictionsExpanded, accessRestriction,
        ocsDefaults, ratingList, slices, newlyAddedSliceIndex
      }}
      actions={{
        setInputName, setProfileTitle, setAuthData, setUsimType, setUeAmbr, setIsAccessRestrictionsExpanded, setAccessRestriction,
        setOcsDefaults, addSlice, handleSliceChange, removeSlice
      }}
    />;
  };

  // --- Root Return: Modal skeleton & sidebar ---
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content workflow-modal animate-modal-enter" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="workflow-header">
          <div className="workflow-title-group">
            <div>
              <h2 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 600, color: "var(--text-main)" }}>{profileName ? (profileTitle || profileName) : t("prof_new_profile")}</h2>
              {!profileName && <p style={{ margin: "0.25rem 0 0", color: "var(--text-muted)", fontSize: "0.9rem" }}>{t("prof_new_desc")}</p>}
            </div>
          </div>
          <div className="workflow-header-actions">
            {!isEditing && (
              <button className="btn-icon" onClick={() => setIsEditing(true)} title={t("prof_btn_edit")}><Pencil size={24} color="var(--primary)" /></button>
            )}
            {profileName && <button className="btn-icon" onClick={handleDelete} title={t("prof_btn_delete")} disabled={isDeleting || isDeleteConfirmOpen}><Trash2 size={24} color="var(--danger)" /></button>}
            <div style={{ width: "1px", height: "30px", background: "var(--surface-border)", margin: "0 0.5rem" }} />
            <button className="btn-icon" onClick={onClose} title={t("close")}><X size={26} color="var(--text-muted)" /></button>
          </div>
        </div>

        {isDeleteConfirmOpen && (
          <div style={{ padding: "0 1.5rem" }}>
            <ConfirmActionPanel
              title={t("prof_del_confirm", { name: profileName || "" })}
              message={t("prof_del_desc")}
              confirmLabel={t("delete")}
              cancelLabel={t("cancel")}
              isWorking={isDeleting}
              onConfirm={executeDelete}
              onCancel={() => setIsDeleteConfirmOpen(false)}
            />
          </div>
        )}

        {/* Body: Left TOC + Right Content */}
        <div className="workflow-body">
          <div className="workflow-sidebar">
            <h4 style={{ fontSize: "0.85rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "1rem", paddingLeft: "0.5rem" }}>{t("sections")}</h4>
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
          <div style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
            {isEditing ? t("prof_msg_edit") : t("prof_msg_view")}
          </div>
          <div className="workflow-footer-actions">
            <button className="btn btn-outline" onClick={onClose}>{t("cancel")}</button>
            {isEditing ? (
              <button className="btn btn-primary" onClick={handleSave} disabled={isSaving || (!profileName && !inputName)}>
                <Save size={16}/> {isSaving ? t("sub_btn_saving") : (profileName ? t("prof_btn_save") : t("prof_btn_create"))}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => setIsEditing(true)}>
                <Pencil size={16}/> {t("prof_btn_edit")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
