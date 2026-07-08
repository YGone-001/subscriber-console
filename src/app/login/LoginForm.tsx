import { Eye, EyeOff, Loader2, Lock, User } from "lucide-react";
import Image from "next/image";

const loginScript = `
(function () {
  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  ready(function () {
    var form = document.getElementById("xcloud-login-form");
    var username = document.getElementById("xcloud-login-username");
    var password = document.getElementById("xcloud-login-password");
    var toggle = document.getElementById("xcloud-password-toggle");
    var eye = document.getElementById("xcloud-eye");
    var eyeOff = document.getElementById("xcloud-eye-off");
    var errorBox = document.getElementById("xcloud-login-error");
    var errorText = document.getElementById("xcloud-login-error-text");
    var submit = document.getElementById("xcloud-login-submit");
    var submitText = document.getElementById("xcloud-login-submit-text");
    var spinner = document.getElementById("xcloud-login-spinner");

    function showError(message) {
      if (!errorBox || !errorText) return;
      errorText.textContent = message || "Login failed";
      errorBox.hidden = false;
    }

    function setLoading(isLoading) {
      if (submit) {
        submit.disabled = isLoading;
        submit.style.cursor = isLoading ? "not-allowed" : "pointer";
        submit.style.opacity = isLoading ? "0.8" : "1";
      }
      if (submitText) submitText.hidden = isLoading;
      if (spinner) spinner.hidden = !isLoading;
    }

    if (toggle && password) {
      toggle.addEventListener("click", function () {
        var showing = password.getAttribute("type") === "text";
        password.setAttribute("type", showing ? "password" : "text");
        if (eye) eye.hidden = !showing;
        if (eyeOff) eyeOff.hidden = showing;
      });
    }

    if (form && username && password) {
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (errorBox) errorBox.hidden = true;
        setLoading(true);

        try {
          var response = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: username.value,
              password: password.value
            })
          });

          if (response.ok) {
            window.location.assign("/");
            return;
          }

          var data = {};
          try {
            data = await response.json();
          } catch (err) {}
          showError(data.error || "Login failed");
        } catch (err) {
          showError("Network error");
        } finally {
          setLoading(false);
        }
      });
    }
  });
})();
`;

export default function LoginForm() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0f172a",
        backgroundImage: `
          radial-gradient(at 0% 0%, hsla(253,16%,7%,1) 0, transparent 50%),
          radial-gradient(at 50% 0%, hsla(225,39%,30%,1) 0, transparent 50%),
          radial-gradient(at 100% 0%, hsla(339,49%,30%,1) 0, transparent 50%)
        `,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: "-10%",
          left: "-10%",
          width: "40vw",
          height: "40vw",
          background: "radial-gradient(circle, rgba(78, 115, 223, 0.4) 0%, transparent 70%)",
          filter: "blur(60px)",
          animation: "float 10s infinite ease-in-out alternate",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: "-10%",
          right: "-10%",
          width: "50vw",
          height: "50vw",
          background: "radial-gradient(circle, rgba(28, 200, 138, 0.25) 0%, transparent 70%)",
          filter: "blur(80px)",
          animation: "float 14s infinite ease-in-out alternate-reverse",
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 10,
          width: "100%",
          maxWidth: "420px",
          padding: "3rem 2.5rem",
          background: "rgba(15, 23, 42, 0.6)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          borderRadius: "24px",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)",
          animation: "slideUpFade 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: "2.5rem" }}>
          <div
            style={{
              height: "64px",
              borderRadius: "16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: "1.25rem",
              overflow: "hidden",
            }}
          >
            <Image
              src="/images/xCloud_picture.png"
              alt="xCloud Trademark"
              width={1254}
              height={1254}
              style={{ height: "100%", width: "auto", objectFit: "contain" }}
            />
          </div>
          <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700, color: "#f8fafc" }}>xCloud Platform</h1>
          <p style={{ margin: "0.5rem 0 0", color: "#94a3b8", fontSize: "0.95rem" }}>
            Core Network Management System
          </p>
        </div>

        <form id="xcloud-login-form" style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          <div
            id="xcloud-login-error"
            hidden
            style={{
              background: "rgba(220, 38, 38, 0.15)",
              border: "1px solid rgba(220, 38, 38, 0.3)",
              color: "#fca5a5",
              padding: "0.75rem 1rem",
              borderRadius: "12px",
              fontSize: "0.85rem",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              animation: "shake 0.4s cubic-bezier(0.36, 0.07, 0.19, 0.97) both",
            }}
          >
            <div style={{ width: "4px", height: "16px", background: "#ef4444", borderRadius: "2px" }} />
            <span id="xcloud-login-error-text">Login failed</span>
          </div>

          <div style={{ position: "relative" }}>
            <div style={{ position: "absolute", left: "1rem", top: "50%", transform: "translateY(-50%)", color: "#64748b" }}>
              <User size={18} />
            </div>
            <input
              id="xcloud-login-username"
              type="text"
              placeholder="Username"
              required
              style={{
                width: "100%",
                padding: "1rem 1rem 1rem 2.75rem",
                background: "rgba(255, 255, 255, 0.03)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                color: "#f8fafc",
                fontSize: "0.95rem",
                borderRadius: "12px",
                outline: "none",
              }}
            />
          </div>

          <div style={{ position: "relative" }}>
            <div style={{ position: "absolute", left: "1rem", top: "50%", transform: "translateY(-50%)", color: "#64748b" }}>
              <Lock size={18} />
            </div>
            <input
              id="xcloud-login-password"
              type="password"
              placeholder="Password"
              required
              style={{
                width: "100%",
                padding: "1rem 2.75rem",
                background: "rgba(255, 255, 255, 0.03)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                color: "#f8fafc",
                fontSize: "0.95rem",
                borderRadius: "12px",
                outline: "none",
              }}
            />
            <button
              id="xcloud-password-toggle"
              type="button"
              title="Show password"
              style={{
                position: "absolute",
                right: "1rem",
                top: "50%",
                transform: "translateY(-50%)",
                background: "none",
                border: "none",
                color: "#64748b",
                cursor: "pointer",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span id="xcloud-eye">
                <Eye size={18} />
              </span>
              <span id="xcloud-eye-off" hidden>
                <EyeOff size={18} />
              </span>
            </button>
          </div>

          <button
            id="xcloud-login-submit"
            type="submit"
            style={{
              marginTop: "0.5rem",
              width: "100%",
              padding: "1rem",
              background: "linear-gradient(to right, #4e73df, #224abe)",
              border: "none",
              borderRadius: "12px",
              color: "white",
              fontSize: "1rem",
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.5rem",
              boxShadow: "0 10px 20px -5px rgba(78, 115, 223, 0.4)",
            }}
          >
            <span id="xcloud-login-spinner" hidden>
              <Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} />
            </span>
            <span id="xcloud-login-submit-text">Login</span>
          </button>
        </form>

        <div style={{ marginTop: "2rem", textAlign: "center", fontSize: "0.8rem", color: "#64748b" }}>
          Protected by xCloud Secure Access
        </div>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
            #xcloud-login-form [hidden] {
              display: none !important;
            }
            @keyframes float {
              0% { transform: translate(0, 0) scale(1); }
              50% { transform: translate(5%, 5%) scale(1.05); }
              100% { transform: translate(-5%, -5%) scale(0.95); }
            }
            @keyframes slideUpFade {
              0% { opacity: 0; transform: translateY(20px) scale(0.98); }
              100% { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes spin {
              100% { transform: rotate(360deg); }
            }
            @keyframes shake {
              10%, 90% { transform: translate3d(-1px, 0, 0); }
              20%, 80% { transform: translate3d(2px, 0, 0); }
              30%, 50%, 70% { transform: translate3d(-3px, 0, 0); }
              40%, 60% { transform: translate3d(3px, 0, 0); }
            }
          `,
        }}
      />
      <script dangerouslySetInnerHTML={{ __html: loginScript }} />
    </div>
  );
}
