"use client";
import "./LoginForm.css";

import { useState } from "react";
import { Eye, EyeOff, Loader2, Lock, User } from "lucide-react";
import Image from "next/image";
import { useI18n } from "@/components/I18nProvider";

export default function LoginForm() {
  const { t } = useI18n();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const username = String(formData.get("username") || "");
    const password = String(formData.get("password") || "");

    setError("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        window.location.assign("/");
        return;
      }

      let data: { error?: string } = {};
      try {
        data = await response.json();
      } catch {
        // Keep the generic fallback below
      }
      setError(data.error || t("login_failed"));
    } catch {
      setError(t("login_network_error"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
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
          {error && (
            <div id="xcloud-login-error" className="login-error-container">
              <div className="login-error-indicator" />
              <span id="xcloud-login-error-text">{error}</span>
            </div>
          )}

          <div className="input-container">
            <div className="input-icon">
              <User size={18} />
            </div>
            <input
              id="xcloud-login-username"
              name="username"
              type="text"
              placeholder={t("login_username")}
              required
              className="login-input"
            />
          </div>

          <div className="input-container">
            <div className="input-icon">
              <Lock size={18} />
            </div>
            <input
              id="xcloud-login-password"
              name="password"
              type={passwordVisible ? "text" : "password"}
              placeholder={t("login_password")}
              required
              className="login-input login-input-password"
            />
            <button
              id="xcloud-password-toggle"
              type="button"
              title={passwordVisible ? t("login_hide_password") : t("login_show_password")}
              onClick={() => setPasswordVisible((visible) => !visible)}
              className="password-toggle"
            >
              <span id="xcloud-eye" hidden={passwordVisible}>
                <Eye size={18} />
              </span>
              <span id="xcloud-eye-off" hidden={!passwordVisible}>
                <EyeOff size={18} />
              </span>
            </button>
          </div>

          <button
            id="xcloud-login-submit"
            type="submit"
            disabled={isLoading}
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
    </div>
  );
}
