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
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "var(--background)", color: "var(--text-main)", padding: "1.5rem" }}>
          <div style={{ padding: "2.5rem", background: "var(--surface)", border: "1px solid var(--surface-border)", borderRadius: "var(--radius-panel)", boxShadow: "var(--shadow-panel)", display: "flex", flexDirection: "column", alignItems: "center", maxWidth: "520px", width: "100%", textAlign: "center" }}>
            <AlertTriangle size={52} color="var(--status-danger)" style={{ marginBottom: "1.25rem", opacity: 0.95 }} />
            <h2 style={{ margin: "0 0 0.75rem", fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>System Error Encountered</h2>
            <p style={{ color: "var(--text-muted)", marginBottom: "1.75rem", fontSize: "0.95rem", lineHeight: 1.55 }}>
              {this.state.error.message || "An unexpected error occurred while rendering the page. This may be due to a temporary service disruption."}
            </p>

            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", justifyContent: "center", marginBottom: "1rem" }}>
              <button
                type="button"
                onClick={this.resetError}
                style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", padding: "0.65rem 1.25rem", background: "var(--primary)", color: "var(--on-accent)", border: "none", borderRadius: "var(--radius-control)", fontWeight: 600, fontSize: "0.9rem", cursor: "pointer" }}
              >
                <RotateCcw size={16} /> Try Again
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", padding: "0.65rem 1.25rem", background: "transparent", color: "var(--text-main)", border: "1px solid var(--surface-border)", borderRadius: "var(--radius-control)", fontWeight: 500, fontSize: "0.9rem", cursor: "pointer" }}
              >
                <RefreshCw size={16} /> Reload Page
              </button>
            </div>

            {this.state.error.stack && (
              <div style={{ width: "100%", marginTop: "1rem", textAlign: "left" }}>
                <button
                  type="button"
                  onClick={() => this.setState((prev) => ({ showDetails: !prev.showDetails }))}
                  style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: "0.8rem", cursor: "pointer", padding: "0.25rem 0", textDecoration: "underline" }}
                >
                  {this.state.showDetails ? "Hide Technical Details" : "Show Technical Details"}
                </button>
                {this.state.showDetails && (
                  <pre style={{ marginTop: "0.5rem", padding: "0.75rem", background: "var(--background)", borderRadius: "var(--radius-small)", fontSize: "0.75rem", overflowX: "auto", color: "var(--status-danger)", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: "160px" }}>
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
