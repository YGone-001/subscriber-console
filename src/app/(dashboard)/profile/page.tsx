"use client";

import { useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { Plus, Clock, Layers, UserRound } from "lucide-react";
import ProfileModal from "@/components/ProfileModal";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useAuth } from "@/hooks/useAuth";

interface ProfileSummary {
  name: string;
  title?: string;
  sliceCount?: number;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

interface ProfilesResponse {
  profiles: ProfileSummary[];
}

/**
 * Profile 列表页
 * 展示所有已创建的配置模板，支持网格布局、搜索过滤和 FAB 新建
 */
export default function ProfilePage() {
  const { t } = useI18n();
  const { data, isLoading, mutate } = useSWR<ProfilesResponse>("/api/profiles", fetcher);
  const profiles = data?.profiles || [];
  const [searchQuery, setSearchQuery] = useState("");
  const { canEditTemplates } = useAuth();

  // 弹窗控制状态
  const [modalProfileName, setModalProfileName] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // 打开模板新建弹窗
  const handleOpenNew = () => {
    setModalProfileName(null);
    setIsModalOpen(true);
  };

  // 打开模板编辑弹窗
  const handleOpenEdit = (name: string) => {
    setModalProfileName(name);
    setIsModalOpen(true);
  };

  // 搜索过滤逻辑: 匹配 name 或 title
  const filteredProfiles = profiles.filter(p =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (p.title && p.title.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <>
      <div className="container animate-fade-in" style={{ padding: "3rem", paddingBottom: "100px" }}>

        {/* Search and primary action */}
        <div className="page-action-bar">
          <input
            type="search"
            className="form-input hover-glass"
            style={{ width: "min(520px, 100%)", borderRadius: "20px", padding: "0.7rem 1.2rem" }}
            placeholder={t("prof_search_ph")}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {canEditTemplates && (
            <div className="page-action-buttons">
              <button className="btn btn-primary" onClick={handleOpenNew} title={t("prof_btn_create")}>
                <Plus size={16} /> {t("prof_new_profile")}
              </button>
            </div>
          )}
        </div>

        {/* Grid */}
        {isLoading ? (
          <div className="text-center mt-8 text-muted">{t("prof_loading_list")}</div>
        ) : filteredProfiles.length === 0 ? (
          <div className="text-center mt-8 text-muted bg-white p-12 shadow" style={{ borderRadius: '4px' }}>
            {searchQuery ? t("prof_no_match") : t("prof_empty_list")}
          </div>
        ) : (
          <div className="imsi-grid">
            {filteredProfiles.map(profile => (
              <div
                key={profile.name}
                className="imsi-card"
                onClick={() => handleOpenEdit(profile.name)}
                style={{ cursor: "pointer", display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1.5rem" }}
              >
                <div style={{ fontSize: "1.25rem", fontWeight: 600, color: "var(--text-main)", marginBottom: "0.25rem" }}>
                  {profile.title || profile.name}
                </div>
                <div style={{ display: "flex", gap: "1.5rem", fontSize: "0.9rem", color: "var(--text-secondary)" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <Layers size={16} /> {t("prof_slices_count", { count: profile.sliceCount || 0 })}
                  </span>
                  {(profile.updatedAt || profile.createdAt) && (
                    <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <Clock size={16} /> {new Date(profile.updatedAt || profile.createdAt || "").toLocaleDateString()}
                    </span>
                  )}
                </div>
                {profile.updatedBy && (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", color: "var(--text-muted)" }}>
                    <UserRound size={14} /> {t("prof_modified_by")} {profile.updatedBy}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* FAB */}
      {canEditTemplates && (
        <button
          className="fab"
          onClick={handleOpenNew}
          title={t("prof_btn_create")}
          aria-label={t("prof_btn_create")}
        >
          <Plus size={28} />
        </button>
      )}

      {isModalOpen && (
        <ProfileModal
          profileName={modalProfileName}
          onClose={() => setIsModalOpen(false)}
          onRefresh={() => mutate()}
        />
      )}
    </>
  );
}
