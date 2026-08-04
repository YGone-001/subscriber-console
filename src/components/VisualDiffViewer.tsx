"use client";

import React, { useState, useMemo } from 'react';
import {
  GitCompare,
  Layers,
  Columns,
  FileCode,
  Copy,
  Check,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
} from 'lucide-react';
import {
  computeObjectDiff,
  computeLineDiff,
  generateUnifiedPatch,
  FieldDiff,
} from '@/lib/diffEngine';
import { useI18n } from '@/components/I18nProvider';
import './diff-viewer.css';

export type DiffViewMode = 'semantic' | 'split' | 'unified';

export interface VisualDiffViewerProps {
  oldData: unknown;
  newData: unknown;
  title?: string;
  defaultMode?: DiffViewMode;
  compact?: boolean;
  showControls?: boolean;
  onClose?: () => void;
}

export default function VisualDiffViewer({
  oldData,
  newData,
  title,
  defaultMode = 'semantic',
  compact = false,
  showControls = true,
}: VisualDiffViewerProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<DiffViewMode>(defaultMode);
  const [searchQuery, setSearchQuery] = useState('');
  const [changesOnly, setChangesOnly] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Compute Object / Field Diff
  const { fields, summary } = useMemo(() => {
    return computeObjectDiff(oldData, newData, {
      includeUnchanged: !changesOnly,
      ignoreKeys: ['_id', '__v'],
    });
  }, [oldData, newData, changesOnly]);

  // Filtered fields based on search query
  const filteredFields = useMemo(() => {
    if (!searchQuery.trim()) return fields;
    const q = searchQuery.toLowerCase();
    return fields.filter(
      (f) =>
        f.label.toLowerCase().includes(q) ||
        f.path.toLowerCase().includes(q) ||
        f.formattedOld.toLowerCase().includes(q) ||
        f.formattedNew.toLowerCase().includes(q)
    );
  }, [fields, searchQuery]);

  // Compute Text & Line Diff
  const oldJson = useMemo(() => (oldData !== undefined && oldData !== null ? JSON.stringify(oldData, null, 2) : ''), [oldData]);
  const newJson = useMemo(() => (newData !== undefined && newData !== null ? JSON.stringify(newData, null, 2) : ''), [newData]);
  const lineDiffs = useMemo(() => computeLineDiff(oldJson, newJson), [oldJson, newJson]);

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // Fallback
    }
  };

  const handleCopyPatch = () => {
    const patch = generateUnifiedPatch(oldData, newData, title || 'Payload');
    copyToClipboard(patch, 'patch');
  };

  const handleCopyNew = () => {
    copyToClipboard(newJson, 'new');
  };

  return (
    <div className={`diff-viewer-container ${compact ? 'compact' : ''}`}>
      {/* Header & Controls Toolbar */}
      {showControls && (
        <div className="diff-viewer-header">
          <div className="diff-viewer-title-row">
            <h3 className="diff-viewer-title">
              <GitCompare size={18} color="var(--primary)" />
              {title || t("diff_viewer_title")}
            </h3>

            {summary.hasChanges ? (
              <>
                {summary.added > 0 && <span className="diff-stat-pill add">+{summary.added} {t("diff_stat_added")}</span>}
                {summary.modified > 0 && <span className="diff-stat-pill mod">~{summary.modified} {t("diff_stat_modified")}</span>}
                {summary.removed > 0 && <span className="diff-stat-pill del">-{summary.removed} {t("diff_stat_removed")}</span>}
              </>
            ) : (
              <span className="diff-stat-pill clean">
                <CheckCircle2 size={12} color="#10b981" /> {t("diff_no_changes")}
              </span>
            )}
          </div>

          <div className="diff-viewer-toolbar">
            {/* View Mode Switcher */}
            <div className="diff-mode-tabs">
              <button
                type="button"
                className={`diff-mode-btn ${mode === 'semantic' ? 'active' : ''}`}
                onClick={() => setMode('semantic')}
                title={t("diff_mode_semantic")}
              >
                <Layers size={13} />
                {t("diff_mode_semantic")}
              </button>
              <button
                type="button"
                className={`diff-mode-btn ${mode === 'split' ? 'active' : ''}`}
                onClick={() => setMode('split')}
                title={t("diff_mode_split")}
              >
                <Columns size={13} />
                {t("diff_mode_split")}
              </button>
              <button
                type="button"
                className={`diff-mode-btn ${mode === 'unified' ? 'active' : ''}`}
                onClick={() => setMode('unified')}
                title={t("diff_mode_unified")}
              >
                <FileCode size={13} />
                {t("diff_mode_unified")}
              </button>
            </div>

            {/* Semantic Mode Controls */}
            {mode === 'semantic' && (
              <>
                <div className="diff-search-wrap">
                  <input
                    type="text"
                    className="diff-search-input"
                    placeholder={t("diff_search_ph")}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                <label className="diff-filter-toggle">
                  <input
                    type="checkbox"
                    checked={changesOnly}
                    onChange={(e) => setChangesOnly(e.target.checked)}
                  />
                  <span>{t("diff_changes_only")}</span>
                </label>
              </>
            )}

            {/* Quick Actions */}
            <button
              type="button"
              className="btn btn-outline diff-btn-action"
              onClick={handleCopyPatch}
              title={t("diff_copy_patch")}
            >
              {copiedKey === 'patch' ? <Check size={13} color="#10b981" /> : <Copy size={13} />}
              {t("diff_copy_patch")}
            </button>
            <button
              type="button"
              className="btn btn-outline diff-btn-action"
              onClick={handleCopyNew}
              title={t("diff_copy_new")}
            >
              {copiedKey === 'new' ? <Check size={13} color="#10b981" /> : <Copy size={13} />}
              {t("diff_copy_new")}
            </button>
          </div>
        </div>
      )}

      {/* 1. Semantic Field Grid Mode */}
      {mode === 'semantic' && (
        <div className="diff-semantic-body">
          {filteredFields.length === 0 ? (
            <div className="diff-empty-state">
              <ShieldCheck size={36} color="var(--text-secondary)" />
              <div className="diff-empty-title">{t("diff_no_differences_found")}</div>
              <p>{t("diff_no_differences_desc")}</p>
            </div>
          ) : (
            filteredFields.map((field: FieldDiff) => (
              <div key={field.path} className={`diff-field-card ${field.type}`}>
                <div className="diff-field-info">
                  <div className="diff-field-label-group">
                    <span className="diff-field-label">{field.label}</span>
                    {field.category && <span className="diff-category-badge">{field.category}</span>}
                  </div>
                  <span className="diff-field-path">{field.path}</span>
                </div>

                <div className="diff-field-values">
                  {field.type === 'modified' && (
                    <>
                      <div className="diff-val-box diff-val-old" title={field.formattedOld}>
                        {field.formattedOld}
                      </div>
                      <ArrowRight size={14} className="diff-arrow-icon" />
                      <div className="diff-val-box diff-val-new" title={field.formattedNew}>
                        {field.formattedNew}
                      </div>
                    </>
                  )}

                  {field.type === 'added' && (
                    <div className="diff-val-box diff-val-new" title={field.formattedNew}>
                      + {field.formattedNew}
                    </div>
                  )}

                  {field.type === 'removed' && (
                    <div className="diff-val-box diff-val-old" title={field.formattedOld}>
                      - {field.formattedOld}
                    </div>
                  )}

                  {field.type === 'unchanged' && (
                    <div className="diff-val-box diff-val-unchanged" title={field.formattedNew}>
                      {field.formattedNew}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* 2. Side-by-Side Split View Mode */}
      {mode === 'split' && (
        <div className="diff-split-body">
          <div className="diff-split-pane">
            <div className="diff-split-pane-header">
              {t("diff_pane_previous")}
            </div>
            <pre className="diff-split-pre">{oldJson || '—'}</pre>
          </div>
          <div className="diff-split-pane">
            <div className="diff-split-pane-header">
              {t("diff_pane_current")}
            </div>
            <pre className="diff-split-pre">{newJson || '—'}</pre>
          </div>
        </div>
      )}

      {/* 3. Unified Patch View Mode */}
      {mode === 'unified' && (
        <div className="diff-unified-body">
          {lineDiffs.map((line, idx) => (
            <div key={idx} className={`diff-line-row ${line.type}`}>
              <div className="diff-line-nums">
                <span>{line.oldLineNumber || ' '}</span>
                <span>{line.newLineNumber || ' '}</span>
              </div>
              <div className="diff-line-prefix">
                {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
              </div>
              <div className="diff-line-text">{line.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
