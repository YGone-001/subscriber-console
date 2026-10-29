/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/subscribers/components/SubscriberToolbar.tsx
 * Adaptations: the analytics sync button was removed. It called an unrelated
 * analytics endpoint, was visible to read-only users, and had no effect on the
 * subscriber list.
 */
import React from "react";
import { Trash2, Plus, Layers, ClipboardPenLine, Upload } from "lucide-react";
import { useI18n } from '../../../providers/I18nProvider';

export interface SubscriberToolbarProps {
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  setCurrentPage: (page: number) => void;
  setSelectedImsis: React.Dispatch<React.SetStateAction<string[]>>;
  selectedImsis: string[];
  canEditSubscribers: boolean;
  setIsBatchUpdateModalOpen: (open: boolean) => void;
  handleBulkDelete: () => void;
  isDeletingBulk: boolean;
  pendingDelete: unknown;
  handleOpenNew: () => void;
  setIsBatchOpen: (open: boolean) => void;
  onOpenImport: () => void;
}

export function SubscriberToolbar(props: SubscriberToolbarProps) {
  const { t } = useI18n();
  const {
    searchQuery, setSearchQuery, setCurrentPage, setSelectedImsis,
    selectedImsis, canEditSubscribers, setIsBatchUpdateModalOpen,
    handleBulkDelete, isDeletingBulk, pendingDelete,
    handleOpenNew, setIsBatchOpen, onOpenImport,
  } = props;

  return (
    <div className="page-action-bar">
      <div className="action-bar-left">
        <input
          type="search"
          className="form-input hover-glass search-input"
          aria-label={t("subscriber_search_placeholder")}
          placeholder={t("subscriber_search_placeholder")}
          value={searchQuery}
          onChange={e => { setSearchQuery(e.target.value); setCurrentPage(1); setSelectedImsis([]); }}
        />
        {selectedImsis.length > 0 && (
          <div className="bulk-actions-container animate-fade-in">
            <span className="bulk-actions-count">{selectedImsis.length} {t("selected")}</span>
            <div className="bulk-actions-buttons">
              {canEditSubscribers && (
                <button className="btn btn-bulk-outline" onClick={() => setIsBatchUpdateModalOpen(true)}>
                  <ClipboardPenLine size={14}/> {t('sub_batch_update_action')}
                </button>
              )}
              {canEditSubscribers && (
                <button className="btn-bulk-danger" onClick={handleBulkDelete} disabled={isDeletingBulk || Boolean(pendingDelete)}>
                  {isDeletingBulk ? <span className="spinner spinner-sm"/> : <Trash2 size={14}/>}
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
             <button
               className="btn btn-outline btn-primary-padded"
               onClick={onOpenImport}
               title={t("sub_import_action")}
             >
               <Upload size={16} /> {t("sub_import_action")}
             </button>
           </>
         )}
      </div>
    </div>
  );
}
