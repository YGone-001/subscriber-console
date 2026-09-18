"use client";

import { RefreshCw } from "lucide-react";

interface RefreshButtonProps {
  loading?: boolean;
  onClick: () => void;
  label?: string;
  size?: number;
  className?: string;
  title?: string;
}

export default function RefreshButton({
  loading = false,
  onClick,
  label,
  size = 14,
  className = "btn btn-outline",
  title,
}: RefreshButtonProps) {
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={loading}
      title={title}
    >
      <RefreshCw size={size} className={loading ? "spin" : ""} />
      {label && <span>{label}</span>}
    </button>
  );
}
