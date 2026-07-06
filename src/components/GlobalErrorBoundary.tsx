"use client";

import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class GlobalErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "var(--background)", color: "var(--text-main)" }}>
          <div style={{ padding: "2.5rem", background: "var(--surface)", border: "1px solid var(--surface-border)", borderRadius: "16px", boxShadow: "0 10px 40px rgba(0,0,0,0.1)", display: "flex", flexDirection: "column", alignItems: "center", maxWidth: "450px", textAlign: "center" }}>
            <AlertTriangle size={56} color="var(--danger)" style={{ marginBottom: "1.5rem", opacity: 0.9 }} />
            <h2 style={{ margin: "0 0 1rem", fontSize: "1.6rem", fontWeight: 700 }}>System Error</h2>
            <p style={{ color: "var(--text-muted)", marginBottom: "2rem", fontSize: "0.95rem", lineHeight: 1.5 }}>
              {this.state.error?.message || "An unexpected error occurred while rendering the page. This may be due to a temporary service disruption."}
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.75rem 1.75rem", background: "linear-gradient(135deg, var(--primary) 0%, var(--primary-hover) 100%)", color: "white", border: "none", borderRadius: "8px", fontWeight: 600, cursor: "pointer", transition: "transform 0.2s, box-shadow 0.2s", boxShadow: "0 4px 14px 0 rgba(59, 130, 246, 0.39)" }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.05)"; e.currentTarget.style.boxShadow = "0 6px 20px rgba(59, 130, 246, 0.5)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 4px 14px 0 rgba(59, 130, 246, 0.39)"; }}
            >
              <RefreshCw size={18} /> Reload System
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
