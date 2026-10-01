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
        <div className="global-error">
          <div className="global-error-card">
            <AlertTriangle size={52} color="var(--status-danger)" className="global-error-icon" />
            <h2 className="global-error-title">System Error Encountered</h2>
            <p className="global-error-message">
              {this.state.error.message || "An unexpected error occurred while rendering the page. This may be due to a temporary service disruption."}
            </p>

            <div className="global-error-actions">
              <button
                type="button"
                onClick={this.resetError}
                className="global-error-btn global-error-btn-primary"
              >
                <RotateCcw size={16} /> Try Again
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="global-error-btn global-error-btn-secondary"
              >
                <RefreshCw size={16} /> Reload Page
              </button>
            </div>

            {this.state.error.stack && (
              <div className="global-error-details">
                <button
                  type="button"
                  onClick={() => this.setState((prev) => ({ showDetails: !prev.showDetails }))}
                  className="global-error-toggle"
                >
                  {this.state.showDetails ? "Hide Technical Details" : "Show Technical Details"}
                </button>
                {this.state.showDetails && (
                  <pre className="global-error-pre">
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
