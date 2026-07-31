const fs = require('fs');

const loginFormPath = 'c:/Users/pc/Desktop/web_ui/src/app/login/LoginForm.tsx';
let loginFormCode = fs.readFileSync(loginFormPath, 'utf8');

const replacements = [
  {
    regex: /style=\{\{\n\s*minHeight: "100vh",\n\s*display: "flex",\n\s*alignItems: "center",\n\s*justifyContent: "center",\n\s*backgroundColor: "#0f172a",\n\s*backgroundImage: `[^`]+`,\n\s*position: "relative",\n\s*overflow: "hidden",\n\s*\}\}/g,
    replace: 'className="login-container"'
  },
  {
    regex: /style=\{\{\n\s*position: "absolute",\n\s*top: "-10%",\n\s*left: "-10%",\n\s*width: "40vw",\n\s*height: "40vw",\n\s*background: "radial-gradient\([^)]+\)",\n\s*filter: "blur\(60px\)",\n\s*animation: "float 10s infinite ease-in-out alternate",\n\s*\}\}/g,
    replace: 'className="login-bg-blob-1"'
  },
  {
    regex: /style=\{\{\n\s*position: "absolute",\n\s*bottom: "-10%",\n\s*right: "-10%",\n\s*width: "50vw",\n\s*height: "50vw",\n\s*background: "radial-gradient\([^)]+\)",\n\s*filter: "blur\(80px\)",\n\s*animation: "float 14s infinite ease-in-out alternate-reverse",\n\s*\}\}/g,
    replace: 'className="login-bg-blob-2"'
  },
  {
    regex: /style=\{\{\n\s*position: "relative",\n\s*zIndex: 10,\n\s*width: "100%",\n\s*maxWidth: "420px",\n\s*padding: "3rem 2.5rem",\n\s*background: "rgba\(15, 23, 42, 0.6\)",\n\s*backdropFilter: "blur\(24px\)",\n\s*WebkitBackdropFilter: "blur\(24px\)",\n\s*border: "1px solid rgba\(255, 255, 255, 0.1\)",\n\s*borderRadius: "24px",\n\s*boxShadow: "0 25px 50px -12px rgba\(0, 0, 0, 0.5\)",\n\s*animation: "slideUpFade 0.6s cubic-bezier\(0.16, 1, 0.3, 1\)",\n\s*\}\}/g,
    replace: 'className="login-card"'
  },
  {
    regex: /style=\{\{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: "2.5rem" \}\}/g,
    replace: 'className="login-header"'
  },
  {
    regex: /style=\{\{\n\s*height: "64px",\n\s*borderRadius: "16px",\n\s*display: "flex",\n\s*alignItems: "center",\n\s*justifyContent: "center",\n\s*marginBottom: "1.25rem",\n\s*overflow: "hidden",\n\s*\}\}/g,
    replace: 'className="login-logo-container"'
  },
  {
    regex: /style=\{\{ height: "100%", width: "auto", objectFit: "contain" \}\}/g,
    replace: 'className="login-logo"'
  },
  {
    regex: /style=\{\{ margin: 0, fontSize: "1.75rem", fontWeight: 700, color: "#f8fafc" \}\}/g,
    replace: 'className="login-title"'
  },
  {
    regex: /style=\{\{ margin: "0.5rem 0 0", color: "#94a3b8", fontSize: "0.95rem" \}\}/g,
    replace: 'className="login-subtitle"'
  },
  {
    regex: /style=\{\{ display: "flex", flexDirection: "column", gap: "1.25rem" \}\}/g,
    replace: 'className="login-form"'
  },
  {
    regex: /style=\{\{\n\s*background: "rgba\(220, 38, 38, 0.15\)",\n\s*border: "1px solid rgba\(220, 38, 38, 0.3\)",\n\s*color: "#fca5a5",\n\s*padding: "0.75rem 1rem",\n\s*borderRadius: "12px",\n\s*fontSize: "0.85rem",\n\s*display: "flex",\n\s*alignItems: "center",\n\s*gap: "0.5rem",\n\s*animation: "shake 0.4s cubic-bezier\(0.36, 0.07, 0.19, 0.97\) both",\n\s*\}\}/g,
    replace: 'className="login-error-container"'
  },
  {
    regex: /style=\{\{ width: "4px", height: "16px", background: "#ef4444", borderRadius: "2px" \}\}/g,
    replace: 'className="login-error-indicator"'
  },
  {
    regex: /style=\{\{ position: "relative" \}\}/g,
    replace: 'className="input-container"'
  },
  {
    regex: /style=\{\{ position: "absolute", left: "1rem", top: "50%", transform: "translateY\(-50%\)", color: "#64748b" \}\}/g,
    replace: 'className="input-icon"'
  },
  {
    regex: /style=\{\{\n\s*width: "100%",\n\s*padding: "1rem 1rem 1rem 2.75rem",\n\s*background: "rgba\(255, 255, 255, 0.03\)",\n\s*border: "1px solid rgba\(255, 255, 255, 0.1\)",\n\s*color: "#f8fafc",\n\s*fontSize: "0.95rem",\n\s*borderRadius: "12px",\n\s*outline: "none",\n\s*\}\}/g,
    replace: 'className="login-input"'
  },
  {
    regex: /style=\{\{\n\s*width: "100%",\n\s*padding: "1rem 2.75rem",\n\s*background: "rgba\(255, 255, 255, 0.03\)",\n\s*border: "1px solid rgba\(255, 255, 255, 0.1\)",\n\s*color: "#f8fafc",\n\s*fontSize: "0.95rem",\n\s*borderRadius: "12px",\n\s*outline: "none",\n\s*\}\}/g,
    replace: 'className="login-input login-input-password"'
  },
  {
    regex: /style=\{\{\n\s*position: "absolute",\n\s*right: "1rem",\n\s*top: "50%",\n\s*transform: "translateY\(-50%\)",\n\s*background: "none",\n\s*border: "none",\n\s*color: "#64748b",\n\s*cursor: "pointer",\n\s*padding: 0,\n\s*display: "flex",\n\s*alignItems: "center",\n\s*justifyContent: "center",\n\s*\}\}/g,
    replace: 'className="password-toggle"'
  },
  {
    regex: /style=\{\{\n\s*marginTop: "0.5rem",\n\s*width: "100%",\n\s*padding: "1rem",\n\s*background: "linear-gradient\(to right, #4e73df, #224abe\)",\n\s*border: "none",\n\s*borderRadius: "12px",\n\s*color: "white",\n\s*fontSize: "1rem",\n\s*fontWeight: 600,\n\s*cursor: isLoading \? "not-allowed" : "pointer",\n\s*opacity: isLoading \? "0.8" : "1",\n\s*display: "flex",\n\s*alignItems: "center",\n\s*justifyContent: "center",\n\s*gap: "0.5rem",\n\s*boxShadow: "0 10px 20px -5px rgba\(78, 115, 223, 0.4\)",\n\s*\}\}/g,
    replace: 'className="login-submit-btn"'
  },
  {
    regex: /style=\{\{ animation: "spin 1s linear infinite" \}\}/g,
    replace: 'className="login-spinner"'
  },
  {
    regex: /style=\{\{ marginTop: "2rem", textAlign: "center", fontSize: "0.8rem", color: "#64748b" \}\}/g,
    replace: 'className="login-footer"'
  }
];

for (const rep of replacements) {
  loginFormCode = loginFormCode.replace(rep.regex, rep.replace);
}

fs.writeFileSync(loginFormPath, loginFormCode);
