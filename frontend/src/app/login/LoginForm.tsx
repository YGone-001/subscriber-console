"use client";
import "./LoginForm.css";

import { useState, useEffect } from "react";
import { Eye, EyeOff, Loader2, Lock, User } from "lucide-react";
import Image from "next/image";
import { useI18n } from "@/components/I18nProvider";
import { Field } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { mapLoginResponse, type LoginUiState } from "@/lib/auth-ui";

export default function LoginForm({ sessionExpired = false }: { sessionExpired?: boolean }) {
  const { t } = useI18n();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [errorState, setErrorState] = useState<LoginUiState | null>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [showSessionNotice, setShowSessionNotice] = useState(sessionExpired);
  const isCooldownActive = cooldownRemaining > 0;

  // Cooldown countdown manager
  useEffect(() => {
    if (!isCooldownActive) return;

    const timer = setInterval(() => {
      setCooldownRemaining((prev) => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isCooldownActive]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLoading || cooldownRemaining > 0) return;

    const formData = new FormData(event.currentTarget);
    const username = String(formData.get("username") || "");
    const password = String(formData.get("password") || "");

    setShowSessionNotice(false);
    setErrorState(null);
    setIsLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/");
        return;
      }

      let data: { error?: string; code?: string } = {};
      try {
        data = await response.json();
      } catch {
        // Fall back to status-based mapping
      }

      const retryAfterHeader = response.headers.get("retry-after");
      const mapped = mapLoginResponse(response.status, data, retryAfterHeader);
      setErrorState(mapped);

      if (mapped.retryAfterSeconds > 0) {
        setCooldownRemaining(mapped.retryAfterSeconds);
      }
    } catch {
      setErrorState(mapLoginResponse(undefined));
    } finally {
      setIsLoading(false);
    }
  };

  const getErrorMessage = (): string => {
    if (!errorState) return "";
    if (errorState.category === "rate_limited") {
      if (cooldownRemaining > 0) {
        return `${t("login_rate_limited")} ${t("login_retry_after", { seconds: cooldownRemaining })}`;
      }
      return t("login_rate_limited");
    }
    return t(errorState.i18nKey);
  };

  const errorMessage = getErrorMessage();
  const isSubmitDisabled = isLoading || cooldownRemaining > 0;

  return (
    <main className="login-container">
      <div className="login-bg-blob-1" />
      <div className="login-bg-blob-2" />

      <div className="login-card">
        <div className="login-header">
          <div className="login-logo-container">
            <Image
              src="/images/xCloud_picture.png"
              alt="xCloud Trademark"
              width={1254}
              height={1254}
              className="login-logo"
            />
          </div>
          <h1 className="login-title">{t("login_title")}</h1>
          <p className="login-subtitle">
            {t("login_subtitle")}
          </p>
        </div>

        <form id="xcloud-login-form" onSubmit={handleSubmit} className="login-form">
          {showSessionNotice && !errorMessage ? (
            <div id="xcloud-session-notice" className="login-session-container" role="status">
              <div className="login-session-indicator" aria-hidden="true" />
              <span id="xcloud-session-notice-text">{t("login_session_expired")}</span>
            </div>
          ) : null}

          {errorMessage && (
            <div id="xcloud-login-error" className="login-error-container" role="alert" aria-live="assertive">
              <div className="login-error-indicator" aria-hidden="true" />
              <span id="xcloud-login-error-text">{errorMessage}</span>
            </div>
          )}

          <Field className="input-container" labelClassName="login-field-label" htmlFor="xcloud-login-username" label={t("login_username")}>
            <div className="input-icon" aria-hidden="true">
              <User size={18} />
            </div>
            <input
              id="xcloud-login-username"
              name="username"
              type="text"
              placeholder={t("login_username")}
              autoComplete="username"
              aria-invalid={Boolean(errorMessage)}
              aria-describedby={errorMessage ? "xcloud-login-error-text" : undefined}
              required
              className="login-input"
            />
          </Field>

          <Field className="input-container" labelClassName="login-field-label" htmlFor="xcloud-login-password" label={t("login_password")}>
            <div className="input-icon" aria-hidden="true">
              <Lock size={18} />
            </div>
            <input
              id="xcloud-login-password"
              name="password"
              type={passwordVisible ? "text" : "password"}
              placeholder={t("login_password")}
              autoComplete="current-password"
              aria-invalid={Boolean(errorMessage)}
              aria-describedby={errorMessage ? "xcloud-login-error-text" : undefined}
              required
              className="login-input login-input-password"
            />
            <IconButton
              id="xcloud-password-toggle"
              label={passwordVisible ? t("login_hide_password") : t("login_show_password")}
              aria-pressed={passwordVisible}
              onClick={() => setPasswordVisible((visible) => !visible)}
              className="password-toggle"
            >
              <span id="xcloud-eye" hidden={passwordVisible}>
                <Eye size={18} />
              </span>
              <span id="xcloud-eye-off" hidden={!passwordVisible}>
                <EyeOff size={18} />
              </span>
            </IconButton>
          </Field>

          <button
            id="xcloud-login-submit"
            type="submit"
            disabled={isSubmitDisabled}
            className="login-submit-btn"
          >
            <span id="xcloud-login-spinner" hidden={!isLoading}>
              <Loader2 size={20} className="login-spinner" />
            </span>
            <span id="xcloud-login-submit-text" hidden={isLoading}>{t("login_button")}</span>
          </button>
        </form>

        <div className="login-footer">
          {t("login_protected")}
        </div>
      </div>
    </main>
  );
}
