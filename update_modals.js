const fs = require('fs');

const basePath = 'c:/Users/pc/Desktop/web_ui/src/components/';
const files = [
  'ProfileModal.tsx',
  'BatchCreateModal.tsx',
  'BulkPolicyModal.tsx',
  'TrafficAdjustmentModal.tsx'
];

for (const file of files) {
  let code = fs.readFileSync(basePath + file, 'utf8');
  
  if (!code.includes('import "./modals.css";')) {
    code = code.replace(/(import\s+[^;]+;(\r?\n))+/, match => match + 'import "./modals.css";\n');
  }

  // ProfileModal.tsx
  if (file === 'ProfileModal.tsx') {
    code = code.replace(/style=\{\{ marginBottom: "1\.5rem" \}\}/g, 'className="dash-card animate-fade-in pm-card"');
    code = code.replace(/style=\{\{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" \}\}/g, 'className="dash-card-header pm-card-header"');
    code = code.replace(/style=\{\{ display: "flex", alignItems: "center", gap: "0\.75rem" \}\}/g, 'className="pm-card-header-left"');
    code = code.replace(/style=\{\{ margin: 0, fontSize: "1rem" \}\}/g, 'className="pm-card-header-title"');
    code = code.replace(/style=\{\{ margin: "0\.25rem 0 0", color: "var\(--text-muted\)", fontSize: "0\.82rem" \}\}/g, 'className="pm-card-header-desc"');
    code = code.replace(/style=\{\{ padding: "0\.45rem 0\.8rem", fontSize: "0\.82rem" \}\}/g, 'className="btn btn-outline pm-refresh-btn"');
    code = code.replace(/style=\{\{ display: "grid", gridTemplateColumns: "minmax\(260px, 0\.9fr\) minmax\(320px, 1\.1fr\)", gap: "1rem" \}\}/g, 'className="dash-card-body pm-card-body"');
    code = code.replace(/style=\{\{ display: "flex", flexDirection: "column", gap: "0\.65rem", maxHeight: "360px", overflowY: "auto", paddingRight: "0\.25rem" \}\}/g, 'className="pm-versions-list"');
    code = code.replace(/style=\{\{ padding: "1rem", color: "var\(--text-muted\)", border: "1px dashed var\(--surface-border\)", borderRadius: "8px" \}\}/g, 'className="pm-versions-empty"');
    code = code.replace(/style=\{\{\s*textAlign: "left",\s*border: selectedVersion\?\.versionId === version\.versionId \? "1px solid var\(--primary\)" : "1px solid var\(--surface-border\)",\s*background: selectedVersion\?\.versionId === version\.versionId \? "rgba\(59, 130, 246, 0\.08\)" : "var\(--surface\)",\s*borderRadius: "8px",\s*padding: "0\.8rem",\s*cursor: "pointer",\s*color: "var\(--text-main\)",\s*\}\}/g, 'className={`pm-version-btn ${selectedVersion?.versionId === version.versionId ? "selected" : ""}`}');
    code = code.replace(/style=\{\{ display: "flex", justifyContent: "space-between", gap: "0\.75rem", alignItems: "center" \}\}/g, 'className="pm-version-btn-top"');
    code = code.replace(/style=\{\{ fontSize: "0\.9rem" \}\}/g, 'className="pm-version-btn-title"');
    code = code.replace(/style=\{\{ fontSize: "0\.75rem", color: "var\(--text-muted\)" \}\}/g, 'className="pm-version-btn-slices"');
    code = code.replace(/style=\{\{ marginTop: "0\.4rem", color: "var\(--text-muted\)", fontSize: "0\.78rem" \}\}/g, 'className="pm-version-btn-time"');
    code = code.replace(/style=\{\{ marginTop: "0\.25rem", color: "var\(--text-secondary\)", fontSize: "0\.78rem" \}\}/g, 'className="pm-version-btn-by"');
    code = code.replace(/style=\{\{ border: "1px solid var\(--surface-border\)", borderRadius: "8px", padding: "1rem", minHeight: "220px", background: "var\(--surface\)" \}\}/g, 'className="pm-version-diff"');
    code = code.replace(/style=\{\{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var\(--text-muted\)", textAlign: "center" \}\}/g, 'className="pm-version-diff-empty"');
    code = code.replace(/style=\{\{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", marginBottom: "1rem" \}\}/g, 'className="pm-version-diff-header"');
    code = code.replace(/style=\{\{ display: "flex", alignItems: "center", gap: "0\.5rem", fontWeight: 700 \}\}/g, 'className="pm-version-diff-title"');
    code = code.replace(/style=\{\{ marginTop: "0\.35rem", color: "var\(--text-muted\)", fontSize: "0\.8rem" \}\}/g, 'className="pm-version-diff-meta"');
    code = code.replace(/style=\{\{ padding: "0\.55rem 0\.85rem", fontSize: "0\.82rem", whiteSpace: "nowrap" \}\}/g, 'className="btn btn-primary pm-restore-btn"');
    code = code.replace(/style=\{\{ display: "grid", gap: "0\.5rem" \}\}/g, 'className="pm-diff-rows"');
    code = code.replace(/style=\{\{ display: "flex", justifyContent: "space-between", gap: "1rem", borderBottom: "1px solid var\(--surface-border\)", padding: "0\.55rem 0" \}\}/g, 'className="pm-diff-row"');
    code = code.replace(/style=\{\{ color: "var\(--text-secondary\)" \}\}/g, 'className="pm-diff-label"');
    code = code.replace(/style=\{\{ color: row\.changed \? "var\(--warning\)" : "var\(--success\)", fontWeight: 700 \}\}/g, 'className={row.changed ? "pm-diff-changed" : "pm-diff-unchanged"}');
    code = code.replace(/style=\{\{ marginTop: "1rem", maxHeight: "140px", overflow: "auto", background: "rgba\(0,0,0,0\.05\)", borderRadius: "8px", padding: "0\.75rem", fontSize: "0\.75rem", color: "var\(--text-secondary\)" \}\}/g, 'className="pm-diff-pre"');

    // Headers & footers ProfileModal
    code = code.replace(/style=\{\{ margin: 0, fontSize: "1\.5rem", fontWeight: 600, color: "var\(--text-main\)" \}\}/g, 'className="pm-wf-header-title"');
    code = code.replace(/style=\{\{ margin: "0\.25rem 0 0", color: "var\(--text-muted\)", fontSize: "0\.9rem" \}\}/g, 'className="pm-wf-header-desc"');
    code = code.replace(/style=\{\{ width: "1px", height: "30px", background: "var\(--surface-border\)", margin: "0 0\.5rem" \}\}/g, 'className="pm-wf-header-divider"');
    code = code.replace(/style=\{\{ padding: "0 1\.5rem" \}\}/g, 'className="pm-confirm-panel"');
    code = code.replace(/style=\{\{\s*marginBottom: "1rem",\s*border: "1px solid var\(--surface-border\)",\s*borderRadius: "8px",\s*background: "var\(--surface\)",\s*padding: "1rem",\s*display: "grid",\s*gap: "0\.85rem",\s*\}\}/g, 'className="pm-confirm-stats"');
    code = code.replace(/style=\{\{ display: "grid", gridTemplateColumns: "repeat\(auto-fit, minmax\(160px, 1fr\)\)", gap: "0\.75rem" \}\}/g, 'className="pm-confirm-stats-grid"');
    code = code.replace(/style=\{\{ border: "1px solid var\(--surface-border\)", borderRadius: "8px", padding: "0\.75rem" \}\}/g, 'className="pm-confirm-stat-card"');
    code = code.replace(/style=\{\{ color: "var\(--text-muted\)", fontSize: "0\.72rem" \}\}/g, 'className="table-header-cap pm-confirm-stat-label"');
    code = code.replace(/style=\{\{ marginTop: "0\.35rem", fontSize: "1\.25rem", fontWeight: 800, color: impactedSubscribers > 0 \? "var\(--warning\)" : "var\(--success\)" \}\}/g, 'className={`pm-confirm-stat-value ${impactedSubscribers > 0 ? "warning" : "success"}`}');
    code = code.replace(/style=\{\{ marginTop: "0\.35rem", fontWeight: 800, color: "var\(--text-main\)" \}\}/g, 'className="pm-confirm-stat-value main"');
    code = code.replace(/style=\{\{ display: "grid", gap: "0\.45rem" \}\}/g, 'className="pm-confirm-diff-rows"');
    code = code.replace(/style=\{\{ display: "flex", justifyContent: "space-between", gap: "1rem", padding: "0\.45rem 0", borderBottom: "1px solid var\(--surface-border\)" \}\}/g, 'className="pm-confirm-diff-row"');
    code = code.replace(/style=\{\{ color: "var\(--text-secondary\)" \}\}/g, 'className="pm-confirm-diff-label"');
    code = code.replace(/style=\{\{ color: row\.changed \? "var\(--warning\)" : "var\(--success\)" \}\}/g, 'className={row.changed ? "pm-confirm-diff-changed" : "pm-confirm-diff-unchanged"}');
    code = code.replace(/style=\{\{ color: "var\(--text-muted\)", fontSize: "0\.82rem", lineHeight: 1\.5 \}\}/g, 'className="pm-confirm-note"');
    code = code.replace(/style=\{\{ fontSize: "0\.85rem", color: "var\(--text-muted\)", textTransform: "uppercase", letterSpacing: "0\.05em", marginBottom: "1rem", paddingLeft: "0\.5rem" \}\}/g, 'className="pm-toc-title"');
    code = code.replace(/style=\{\{ color: "var\(--text-muted\)", fontSize: "0\.9rem" \}\}/g, 'className="pm-wf-footer-text"');
  }

  // BatchCreateModal.tsx
  if (file === 'BatchCreateModal.tsx') {
    code = code.replace(/style=\{\{ width: "640px", maxWidth: "95%", borderRadius: "12px", overflow: "hidden" \}\}/g, 'className="modal-content animate-fade-in bc-modal-content"');
    code = code.replace(/style=\{\{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1\.5rem 2rem", borderBottom: "1px solid var\(--surface-border\)" \}\}/g, 'className="bc-header"');
    code = code.replace(/style=\{\{ margin: 0, fontSize: "1\.35rem", fontWeight: 600, color: "var\(--text-main\)" \}\}/g, 'className="bc-header-title"');
    code = code.replace(/style=\{\{ padding: "2rem", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1\.5rem" \}\}/g, 'className="bc-body"');
    code = code.replace(/className=\{`form-input \$\{batchForm\.startImsi && !\/\^\\d\{15\}\$\/\.test\(batchForm\.startImsi\) \? 'border-danger error-shake' : ''\}`\}\n\s*style=\{\{ border: batchForm\.startImsi && !\/\^\\d\{15\}\$\/\.test\(batchForm\.startImsi\) \? "1px solid var\(--danger\)" : undefined \}\}/g, 'className={`form-input ${batchForm.startImsi && !/^\\d{15}$/.test(batchForm.startImsi) ? "border-danger error-shake bc-input-error" : ""}`}');
    code = code.replace(/style=\{\{ color: "var\(--danger\)", fontSize: "0\.8rem", marginTop: "0\.25rem", fontWeight: 500 \}\}/g, 'className="bc-error-text"');
    code = code.replace(/style=\{\{ display: "flex", alignItems: "center", gap: "0\.4rem" \}\}/g, 'className="form-label bc-label-icon"');
    code = code.replace(/style=\{\{ padding: "0 2rem 1rem 2rem", marginTop: "-0\.5rem", minHeight: "1\.5rem" \}\}/g, 'className="bc-preview-container"');
    code = code.replace(/style=\{\{ color: "var\(--text-muted\)", fontSize: "0\.85rem", margin: 0 \}\}/g, 'className="bc-preview-text"');
    code = code.replace(/style=\{\{ padding: "0 2rem 1rem 2rem" \}\}/g, 'className="bc-result-container"');
    code = code.replace(/style=\{\{ padding: "1rem 2rem 2rem 2rem", display: "flex", justifyContent: "flex-end", gap: "1rem" \}\}/g, 'className="bc-footer"');
    code = code.replace(/style=\{\{ padding: "0\.6rem 1\.5rem", borderRadius: "8px" \}\}/g, 'className="btn btn-outline bc-btn"');
    code = code.replace(/style=\{\{ padding: "0\.6rem 1\.5rem", borderRadius: "8px", display: "flex", alignItems: "center", gap: "0\.5rem" \}\}/g, 'className="btn btn-primary bc-btn-primary"');
    code = code.replace(/style=\{\{ padding: "0 1rem" \}\}/g, 'className="bc-processing"');
    code = code.replace(/style=\{\{ zIndex: 9999 \}\}/g, 'className="modal-overlay bc-conflict-overlay"');
    code = code.replace(/style=\{\{ width: "500px", maxWidth: "95%", borderRadius: "12px", overflow: "hidden" \}\}/g, 'className="modal-content animate-fade-in bc-conflict-content"');
    code = code.replace(/style=\{\{ padding: "1\.5rem 2rem", borderBottom: "1px solid var\(--surface-border\)", background: "rgba\(239, 68, 68, 0\.1\)" \}\}/g, 'className="bc-conflict-header"');
    code = code.replace(/style=\{\{ margin: 0, fontSize: "1\.35rem", fontWeight: 600, color: "var\(--danger\)" \}\}/g, 'className="bc-conflict-title"');
    code = code.replace(/style=\{\{ padding: "2rem" \}\}/g, 'className="bc-conflict-body"');
    code = code.replace(/style=\{\{ background: "#fef2f2", color: "#b91c1c", padding: "1\.25rem", borderRadius: "8px", fontWeight: 600, fontSize: "1\.05rem", border: "1px solid #fecaca", marginBottom: "1\.5rem", textAlign: "center" \}\}/g, 'className="bc-conflict-alert"');
    code = code.replace(/style=\{\{ color: "var\(--text-secondary\)", marginBottom: "1\.5rem", lineHeight: 1\.6 \}\}/g, 'className="bc-conflict-desc"');
    code = code.replace(/style=\{\{ display: "flex", flexDirection: "column", gap: "1rem" \}\}/g, 'className="bc-conflict-actions"');
    code = code.replace(/style=\{\{ width: "100%", padding: "0\.8rem", display: "flex", justifyContent: "space-between", alignItems: "center" \}\}/g, 'className="btn btn-primary bc-conflict-btn"');
    code = code.replace(/style=\{\{ fontWeight: 600 \}\}/g, 'className="bc-conflict-btn-label"');
    code = code.replace(/style=\{\{ fontSize: "0\.85rem", opacity: 0\.8 \}\}/g, 'className="bc-conflict-btn-desc"');
    code = code.replace(/style=\{\{ width: "100%", padding: "0\.8rem", background: "#fef2f2", color: "var\(--danger\)", border: "1px solid var\(--danger\)", display: "flex", justifyContent: "space-between", alignItems: "center" \}\}/g, 'className="btn bc-conflict-btn-overwrite"');
    code = code.replace(/style=\{\{ width: "100%", padding: "0\.8rem" \}\}/g, 'className="btn btn-outline bc-conflict-btn-abort"');
    code = code.replace(/style=\{\{ fontWeight: 600, textAlign: "center", display: "block", color: "var\(--text-secondary\)" \}\}/g, 'className="bc-conflict-btn-abort-label"');
  }

  // BulkPolicyModal.tsx
  if (file === 'BulkPolicyModal.tsx') {
    code = code.replace(/style=\{\{ maxWidth: "680px", padding: 0 \}\}/g, 'className="modal-content animate-modal-enter bp-modal-content"');
    code = code.replace(/style=\{\{ padding: "1\.25rem 1\.5rem", borderBottom: "1px solid var\(--surface-border\)" \}\}/g, 'className="workflow-header bp-header"');
    code = code.replace(/style=\{\{ margin: 0, fontSize: "1\.2rem", color: "var\(--text-main\)", display: "flex", alignItems: "center", gap: "0\.5rem" \}\}/g, 'className="bp-header-title"');
    code = code.replace(/style=\{\{ margin: "0\.25rem 0 0", color: "var\(--text-muted\)", fontSize: "0\.9rem" \}\}/g, 'className="bp-header-desc"');
    code = code.replace(/style=\{\{ padding: "1\.5rem", display: "grid", gap: "1\.25rem" \}\}/g, 'className="bp-body"');
    code = code.replace(/style=\{\{ display: "grid", gridTemplateColumns: "minmax\(0, 1\.25fr\) minmax\(220px, 0\.75fr\)", gap: "1rem" \}\}/g, 'className="bp-grid-top"');
    code = code.replace(/style=\{\{ marginTop: "0\.5rem", color: "var\(--text-muted\)", fontSize: "0\.82rem", lineHeight: 1\.5 \}\}/g, 'className="bp-plan-desc"');
    code = code.replace(/style=\{\{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0\.5rem" \}\}/g, 'className="bp-status-grid"');
    code = code.replace(/style=\{\{ justifyContent: "center", minHeight: 40 \}\}/g, 'className={active ? "btn btn-primary bp-status-btn" : "btn btn-outline bp-status-btn"}');
    code = code.replace(/className=\{active \? "btn btn-primary" : "btn btn-outline"\}/g, ''); // Handled above, wait! The regex for style might be in the same element. Let's just do an exact match or use regex carefully.
    // Better:
    code = code.replace(/className=\{active \? "btn btn-primary" : "btn btn-outline"\}\s*style=\{\{ justifyContent: "center", minHeight: 40 \}\}/g, 'className={active ? "btn btn-primary bp-status-btn" : "btn btn-outline bp-status-btn"}');

    code = code.replace(/style=\{\{\s*border: "1px solid var\(--surface-border\)",\s*borderRadius: 8,\s*padding: "0\.9rem",\s*background: resetBalances \? "rgba\(59, 130, 246, 0\.08\)" : "var\(--surface-hover\)",\s*display: "grid",\s*gridTemplateColumns: "24px minmax\(0, 1fr\)",\s*gap: "0\.75rem",\s*cursor: "pointer",\s*\}\}/g, 'className={`bp-reset-label ${resetBalances ? "checked" : "unchecked"}`}');
    code = code.replace(/style=\{\{ display: "flex", alignItems: "center", gap: "0\.45rem", color: "var\(--text-main\)", fontWeight: 700 \}\}/g, 'className="bp-reset-title"');
    code = code.replace(/style=\{\{ display: "block", marginTop: "0\.25rem", color: "var\(--text-muted\)", fontSize: "0\.82rem", lineHeight: 1\.5 \}\}/g, 'className="bp-reset-desc"');
    code = code.replace(/style=\{\{ border: "1px solid var\(--surface-border\)", borderRadius: 8, padding: "0\.9rem", background: "rgba\(16, 185, 129, 0\.08\)" \}\}/g, 'className="bp-preview"');
    code = code.replace(/style=\{\{ color: "var\(--text-muted\)", fontSize: "0\.75rem", marginBottom: "0\.5rem" \}\}/g, 'className="bp-preview-title"');
    code = code.replace(/style=\{\{ display: "grid", gridTemplateColumns: "repeat\(3, minmax\(0, 1fr\)\)", gap: "0\.75rem" \}\}/g, 'className="bp-preview-grid"');
    code = code.replace(/style=\{\{ color: "var\(--text-muted\)", fontSize: "0\.72rem" \}\}/g, 'className="bp-preview-label"');
    code = code.replace(/style=\{\{ color: "var\(--text-main\)", fontWeight: 700 \}\}/g, 'className="bp-preview-value"');
    code = code.replace(/style=\{\{ color: "var\(--text-main\)", fontFamily: "monospace", fontWeight: 700, whiteSpace: "normal", wordBreak: "break-all" \}\}/g, 'className="bp-preview-value bp-preview-imsi"');
    code = code.replace(/style=\{\{ padding: "1rem 1\.5rem", borderTop: "1px solid var\(--surface-border\)" \}\}/g, 'className="workflow-footer bp-footer"');
    code = code.replace(/style=\{\{ color: "var\(--text-muted\)", fontSize: "0\.85rem" \}\}/g, 'className="bp-footer-text"');
  }

  // TrafficAdjustmentModal.tsx
  if (file === 'TrafficAdjustmentModal.tsx') {
    code = code.replace(/style=\{\{ maxWidth: "620px", padding: 0 \}\}/g, 'className="modal-content animate-modal-enter ta-modal-content"');
    code = code.replace(/style=\{\{ padding: "1\.25rem 1\.5rem", borderBottom: "1px solid var\(--surface-border\)" \}\}/g, 'className="workflow-header ta-header"');
    code = code.replace(/style=\{\{ margin: 0, fontSize: "1\.2rem", color: "var\(--text-main\)" \}\}/g, 'className="ta-header-title"');
    code = code.replace(/style=\{\{ margin: "0\.25rem 0 0", color: "var\(--text-muted\)", fontFamily: "monospace", fontSize: "0\.9rem" \}\}/g, 'className="ta-header-desc"');
    code = code.replace(/style=\{\{ padding: "1\.5rem", display: "grid", gap: "1\.25rem" \}\}/g, 'className="ta-body"');
    code = code.replace(/style=\{\{ display: "grid", gridTemplateColumns: "repeat\(4, minmax\(0, 1fr\)\)", gap: "0\.5rem" \}\}/g, 'className="ta-mode-grid"');
    code = code.replace(/className=\{active \? "btn btn-primary" : "btn btn-outline"\}\s*style=\{\{ justifyContent: "center", padding: "0\.65rem 0\.5rem", minHeight: "42px" \}\}/g, 'className={active ? "btn btn-primary ta-mode-btn" : "btn btn-outline ta-mode-btn"}');
    code = code.replace(/style=\{\{ display: "grid", gridTemplateColumns: "repeat\(3, minmax\(0, 1fr\)\)", gap: "0\.75rem" \}\}/g, 'className="ta-stats-grid"');
    code = code.replace(/style=\{\{ border: "1px solid var\(--surface-border\)", borderRadius: 8, padding: "0\.8rem", background: "var\(--surface-hover\)" \}\}/g, 'className="ta-stat-card"');
    code = code.replace(/style=\{\{ color: "var\(--text-muted\)", fontSize: "0\.75rem", marginBottom: "0\.25rem" \}\}/g, 'className="ta-stat-label"');
    code = code.replace(/style=\{\{ fontFamily: "monospace", color: "var\(--text-main\)", fontWeight: 700 \}\}/g, 'className="ta-stat-value"');
    code = code.replace(/style=\{\{ display: "grid", gridTemplateColumns: "minmax\(0, 1fr\) 96px", gap: "0\.5rem" \}\}/g, 'className="ta-byte-input-grid"');
    code = code.replace(/style=\{\{ border: "1px solid var\(--surface-border\)", borderRadius: 8, padding: "0\.9rem", background: "rgba\(59, 130, 246, 0\.08\)" \}\}/g, 'className="ta-preview"');
    code = code.replace(/style=\{\{ color: "var\(--text-muted\)", fontSize: "0\.75rem", marginBottom: "0\.4rem" \}\}/g, 'className="ta-preview-title"');
    code = code.replace(/style=\{\{ display: "flex", gap: "1rem", flexWrap: "wrap", fontFamily: "monospace", color: "var\(--text-main\)", fontWeight: 700 \}\}/g, 'className="ta-preview-values"');
    code = code.replace(/style=\{\{ padding: "1rem 1\.5rem", borderTop: "1px solid var\(--surface-border\)" \}\}/g, 'className="workflow-footer ta-footer"');
    code = code.replace(/style=\{\{ color: "var\(--text-muted\)", fontSize: "0\.85rem" \}\}/g, 'className="ta-footer-text"');
  }
  
  fs.writeFileSync(basePath + file, code);
}
