"use client";

import React, { useEffect, useState } from "react";
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useNotification, ToastItem } from "./NotificationProvider";

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    if (!toast.duration || toast.duration <= 0) return;

    const interval = 50;
    const step = (interval / toast.duration) * 100;

    const timer = setInterval(() => {
      if (!paused) {
        setProgress((prev) => {
          if (prev <= step) {
            clearInterval(timer);
            onDismiss();
            return 0;
          }
          return prev - step;
        });
      }
    }, interval);

    return () => clearInterval(timer);
  }, [toast.duration, paused, onDismiss]);

  const iconMap = {
    critical: <AlertOctagon size={19} className="toast-icon critical" />,
    warning: <AlertTriangle size={19} className="toast-icon warning" />,
    success: <CheckCircle2 size={19} className="toast-icon success" />,
    info: <Info size={19} className="toast-icon info" />,
  };

  return (
    <div
      className={`toast-card toast-card-${toast.type}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role="alert"
    >
      <div className="toast-body">
        <div className="toast-icon-wrap">{iconMap[toast.type] || iconMap.info}</div>
        <div className="toast-content">
          {toast.title && <strong className="toast-title">{toast.title}</strong>}
          <p className="toast-message">{toast.message}</p>
          {toast.action && (
            <button
              type="button"
              className="toast-action-btn"
              onClick={() => {
                toast.action?.onClick();
                onDismiss();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
        <button type="button" className="toast-close-btn" onClick={onDismiss} aria-label="Close notification">
          <X size={15} />
        </button>
      </div>
      {toast.duration && toast.duration > 0 ? (
        <div className="toast-progress-bar" style={{ width: `${progress}%` }} />
      ) : null}
    </div>
  );
}

export default function ToastContainer() {
  const { toasts, removeToast } = useNotification();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack-container" aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => removeToast(toast.id)} />
      ))}
    </div>
  );
}
