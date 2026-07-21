import { useState } from "react";
import { Copy, Check } from "lucide-react";

export const AMBR_UNITS = [
  { label: 'bps', val: 0 }, { label: 'Kbps', val: 1 }, { label: 'Mbps', val: 2 }, { label: 'Gbps', val: 3 }, { label: 'Tbps', val: 4 }
];

export const Pill = ({ enabled, children }: { enabled: boolean, children: React.ReactNode }) => (
  <span className={`pill ${enabled ? 'pill-enabled' : 'pill-disabled'}`}>
    {children}
  </span>
);

export const MaskedValue = ({ label, value, singleLine = false }: { label: string, value: string, singleLine?: boolean }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!value) return;
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!value) return <span style={{ color: "var(--text-muted)", fontSize: "0.95rem" }}>N/A</span>;

  return (
    <div style={{ width: "100%", minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "start", gap: "0.5rem" }}>
      <span
        style={{
          minWidth: 0,
          fontFamily: "monospace",
          color: "var(--text-main)",
          fontSize: "1rem",
          lineHeight: 1.45,
          overflowX: singleLine ? "auto" : undefined,
          overflowWrap: singleLine ? "normal" : "anywhere",
          whiteSpace: singleLine ? "nowrap" : undefined,
          wordBreak: singleLine ? "normal" : "break-all",
        }}
      >
        {value}
      </span>
      <button className="copy-btn" onClick={handleCopy} title={`Copy full ${label}`} style={{ flexShrink: 0 }}>
        {copied ? <Check size={16} color="var(--success)" /> : <Copy size={16} />}
      </button>
    </div>
  );
};

export const getAmbrString = (ambr: any) => {
  if (!ambr || (!ambr.downlink && !ambr.uplink)) return "-";
  const dlUnit = AMBR_UNITS.find(u => u.val === (ambr.downlink?.unit || 1))?.label || '';
  const ulUnit = AMBR_UNITS.find(u => u.val === (ambr.uplink?.unit || 1))?.label || '';
  return `${ambr.downlink?.value || 0} ${dlUnit} / ${ambr.uplink?.value || 0} ${ulUnit}`;
};

export const typeLabel = (t: number) => t === 1 ? 'IPv4' : t === 2 ? 'IPv6' : 'IPv4v6';
