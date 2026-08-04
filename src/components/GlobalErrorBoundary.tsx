"use client";

import React from "react";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode | ((error: Error, reset: () => void) => React.ReactNode);
}

interface State {
  hasError: boolean;
  error: Error | null;
  showDetails: boolean;
}

export class GlobalErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, showDetails: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught rendering error:", error, errorInfo);
  }

  resetError = () => {
    this.setState({ hasError: false, error: null, showDetails: false });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      if (typeof this.props.fallback === "function") {
        return this.props.fallback(this.state.error, this.resetError);
      }
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "var(--background, #0f172a)", color: "var(--text-main, #f8fafc)", padding: "1.5rem" }}>
          <div style={{ padding: "2.5rem", background: "var(--surface, #1e293b)", border: "1px solid var(--surface-border, #334155)", borderRadius: "16px", boxShadow: "0 10px 40px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", alignItems: "center", maxWidth: "520px", width: "100%", textAlign: "center" }}>
            <AlertTriangle size={52} color="var(--danger, #ef4444)" style={{ marginBottom: "1.25rem", opacity: 0.95 }} />
            <h2 style={{ margin: "0 0 0.75rem", fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>System Error Encountered</h2>
            <p style={{ color: "var(--text-muted, #94a3b8)", marginBottom: "1.75rem", fontSize: "0.95rem", lineHeight: 1.55 }}>
              {this.state.error.message || "An unexpected error occurred while rendering the page. This may be due to a temporary service disruption."}
            </p>

            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", justifyContent: "center", marginBottom: "1rem" }}>
              <button
                type="button"
                onClick={this.resetError}
                style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", padding: "0.65rem 1.25rem", background: "var(--primary, #3b82f6)", color: "#ffffff", border: "none", borderRadius: "8px", fontWeight: 600, fontSize: "0.9rem", cursor: "pointer", transition: "all 0.2s ease" }}
              >
                <RotateCcw size={16} /> Try Again
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", padding: "0.65rem 1.25rem", background: "transparent", color: "var(--text-main, #f8fafc)", border: "1px solid var(--surface-border, #475569)", borderRadius: "8px", fontWeight: 500, fontSize: "0.9rem", cursor: "pointer", transition: "all 0.2s ease" }}
              >
                <RefreshCw size={16} /> Reload Page
              </button>
            </div>

            {this.state.error.stack && (
              <div style={{ width: "100%", marginTop: "1rem", textAlign: "left" }}>
                <button
                  type="button"
                  onClick={() => this.setState((prev) => ({ showDetails: !prev.showDetails }))}
                  style={{ background: "none", border: "none", color: "var(--text-muted, #94a3b8)", fontSize: "0.8rem", cursor: "pointer", padding: "0.25rem 0", textDecoration: "underline" }}
                >
                  {this.state.showDetails ? "Hide Technical Details" : "Show Technical Details"}
                </button>
                {this.state.showDetails && (
                  <pre style={{ marginTop: "0.5rem", padding: "0.75rem", background: "rgba(0,0,0,0.3)", borderRadius: "6px", fontSize: "0.75rem", overflowX: "auto", color: "var(--danger, #f87171)", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: "160px" }}>
                    {this.state.error.stack}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
