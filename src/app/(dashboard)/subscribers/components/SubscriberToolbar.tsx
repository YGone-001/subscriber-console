import React from "react";
import { Download, Trash2, Settings2, Plus, Layers, DatabaseZap, FileUp } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";

export function SubscriberToolbar(props: any) {
  const { t } = useI18n();
  const {
    searchQuery, setSearchQuery, setCurrentPage, setSelectedImsis,
    selectedImsis, canEditSubscribers, setIsPolicyModalOpen,
    setIsDataHubOpen, handleBulkDelete, isDeletingBulk, pendingDelete,
    handleOpenNew, setIsBatchOpen, mutateSubscribers, setFeedback
  } = props;

  return (
    <div className="page-action-bar">
      <div className="action-bar-left">
        <input
          type="search"
          className="form-input hover-glass search-input"
          placeholder={t("search_imsi")}
          value={searchQuery}
          onChange={e => { setSearchQuery(e.target.value); setCurrentPage(1); setSelectedImsis([]); }}
        />
        {selectedImsis.length > 0 && (
          <div className="bulk-actions-container animate-fade-in">
            <span className="bulk-actions-count">{selectedImsis.length} {t("selected")}</span>
            <div className="bulk-actions-buttons">
              {canEditSubscribers && (
                <button className="btn btn-bulk-outline" onClick={() => setIsPolicyModalOpen(true)}>
                  <Settings2 size={14}/> {t("change_policy")}
                </button>
              )}
              <button className="btn btn-bulk-outline" onClick={() => setIsDataHubOpen(true)}>
                <Download size={14}/> {t("export_csv")}
              </button>
              {canEditSubscribers && (
                <button className="btn-bulk-danger" onClick={handleBulkDelete} disabled={isDeletingBulk || Boolean(pendingDelete)}>
                  {isDeletingBulk ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }}/> : <Trash2 size={14}/>}
                  {t("delete")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="page-action-buttons">
         {canEditSubscribers && (
           <>
             <button
               className="btn btn-primary btn-primary-padded"
               onClick={handleOpenNew}
               title={t("add_subscriber")}
             >
               <Plus size={16} /> {t("add_subscriber")}
             </button>
             <button
               className="btn btn-outline btn-primary-padded"
               onClick={() => setIsBatchOpen(true)}
               title={t("batch_create")}
             >
               <Layers size={16} /> {t("batch_create")}
             </button>
           </>
         )}
         {/* Mini Sync Button replaces the giant banner */}
         <button
           onClick={async (e) => {
             const btn = e.currentTarget;
             const originalHTML = btn.innerHTML;
             btn.disabled = true;
             btn.classList.add('radar-animating');
             btn.innerHTML = `<span style="opacity: 0.5;">Scanning...</span>`;
             try {
               const res = await fetch('/api/analytics/init', { method: 'POST' });
               if (!res.ok) throw new Error(t("sync_error"));
               await mutateSubscribers();
               btn.innerHTML = `<span style="color:var(--success)">OK</span>`;
               setFeedback({
                 tone: "success",
                 title: t("success"),
                 message: `${t("sync_telemetry")} ${t("sync_ok")}`,
               });
               setTimeout(() => {
                 btn.innerHTML = originalHTML;
                 btn.classList.remove('radar-animating');
                 btn.disabled = false;
               }, 2000);
             } catch (error) {
               btn.innerHTML = `Error`;
               setFeedback({
                 tone: "danger",
                 title: t("error"),
                 message: error instanceof Error ? error.message : t("sync_error"),
               });
               setTimeout(() => {
                 btn.innerHTML = originalHTML;
                 btn.classList.remove('radar-animating');
                 btn.disabled = false;
               }, 2000);
             }
           }}
           title={t("sync_tooltip")}
           className="btn-sync-telemetry"
         >
           <DatabaseZap size={14} color="var(--primary)" /> {t("sync_telemetry")}
         </button>
         <button
           onClick={() => setIsDataHubOpen(true)}
           title={t("datahub_tooltip")}
           className="btn-sync-telemetry"
         >
           <FileUp size={14} color="var(--primary)" /> {t("data_hub")}
         </button>
      </div>
    </div>
  );
}
