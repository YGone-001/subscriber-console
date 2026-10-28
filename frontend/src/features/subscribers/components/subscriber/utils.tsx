/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/subscriber/utils.tsx
 * Adaptations: "use client" dropped; `@/` aliases and CSS-module imports repointed for the Vite runtime.
 */
import { useEffect, useState } from "react";
import { Copy, Check, Eye, EyeOff } from "lucide-react";
import { useI18n } from '../../../../providers/I18nProvider';
import { copyText } from '../../../../lib/clipboard';

export const AMBR_UNITS = [
  { label: 'bps', val: 0 }, { label: 'Kbps', val: 1 }, { label: 'Mbps', val: 2 }, { label: 'Gbps', val: 3 }, { label: 'Tbps', val: 4 }
];

export const Pill = ({ enabled, children }: { enabled: boolean, children: React.ReactNode }) => (
  <span className={`pill ${enabled ? 'pill-enabled' : 'pill-disabled'}`}>
    {children}
  </span>
);

export const MaskedValue = ({
  label,
  value,
  singleLine = false,
  canReveal = true,
}: {
  label: string;
  value: string;
  singleLine?: boolean;
  canReveal?: boolean;
}) => {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(false), 30000);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  const handleCopy = async () => {
    if (!value || !revealed) return;
    if (!(await copyText(value))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!canReveal) return <span className="masked-na">{t("sub_credentials_no_permission")}</span>;
  if (!value) return <span className="masked-na">N/A</span>;

  const masked = "•".repeat(Math.min(20, Math.max(8, value.length)));

  return (
    <div className="masked-row">
      <span
        style={{
          minWidth: 0,
          fontFamily: "monospace",
          color: "var(--text-main)",
          fontSize: "var(--ref-font-size-body)",
          lineHeight: 1.45,
          overflowX: singleLine ? "auto" : undefined,
          overflowWrap: singleLine ? "normal" : "anywhere",
          whiteSpace: singleLine ? "nowrap" : undefined,
          wordBreak: singleLine ? "normal" : "break-all",
        }}
      >
        {revealed ? value : masked}
      </span>
      <button
        type="button"
        className="copy-btn masked-copy"
        onClick={() => setRevealed((current) => !current)}
        title={revealed ? t("sub_credentials_hide") : t("sub_credentials_reveal", { label })}
        aria-label={revealed ? t("sub_credentials_hide") : t("sub_credentials_reveal", { label })}
      >
        {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
      <button
        type="button"
        className="copy-btn masked-copy"
        onClick={handleCopy}
        disabled={!revealed}
        title={t("sub_credentials_copy", { label })}
        aria-label={t("sub_credentials_copy", { label })}
      >
        {copied ? <Check size={16} color="var(--success)" /> : <Copy size={16} />}
      </button>
    </div>
  );
};

export const getAmbrString = (ambr: any) => {
  if (!ambr || (!ambr.downlink && !ambr.uplink)) return "-";
  /* `??` not `||`: unit 0 is a real 3GPP unit (bps), not an absent value. */
  const dlUnit = AMBR_UNITS.find(u => u.val === (ambr.downlink?.unit ?? 1))?.label || '';
  const ulUnit = AMBR_UNITS.find(u => u.val === (ambr.uplink?.unit ?? 1))?.label || '';
  return `${ambr.downlink?.value || 0} ${dlUnit} / ${ambr.uplink?.value || 0} ${ulUnit}`;
};

export const typeLabel = (t: number) => t === 1 ? 'IPv4' : t === 2 ? 'IPv6' : 'IPv4v6';
