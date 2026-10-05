import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export type ToastInput = {
  tone: ToastTone;
  title: string;
  message?: string;
};

type ToastRecord = ToastInput & { id: number };

type ToastContextValue = {
  toasts: ToastRecord[];
  pushToast: (input: ToastInput) => void;
  dismissToast: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS = {
  info: <Info size={16} />,
  success: <CheckCircle2 size={16} />,
  warning: <AlertTriangle size={16} />,
  error: <AlertTriangle size={16} />,
} as const;

const TONE_COLOR: Record<ToastTone, string> = {
  info: 'var(--status-info)',
  success: 'var(--status-success)',
  warning: 'var(--status-warning)',
  error: 'var(--status-danger)',
};

/**
 * Presentation-only toast transport. Toasts announce outcomes that have already
 * been decided by an authoritative backend response; they never assert success.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { ...input, id }]);
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toasts, pushToast, dismissToast }), [toasts, pushToast, dismissToast]);

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used within ToastProvider');
  return value;
}

/** Renders the active toast stack. Keyboard reachable, announced politely. */
export function ToastRegion() {
  const value = useContext(ToastContext);
  if (!value || value.toasts.length === 0) return null;
  return (
    <div className="toast-region" role="region" aria-live="polite" aria-label="Operation feedback">
      {value.toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          <span style={{ color: TONE_COLOR[toast.tone], display: 'flex', paddingTop: '0.1rem' }} aria-hidden="true">
            {ICONS[toast.tone]}
          </span>
          <div className="toast-body">
            <span className="toast-title">{toast.title}</span>
            {toast.message ? <span className="toast-message">{toast.message}</span> : null}
          </div>
          <button type="button" className="op-notice-close-btn" onClick={() => value.dismissToast(toast.id)} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
