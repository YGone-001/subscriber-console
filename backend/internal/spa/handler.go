package spa

import (
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

var customMimeTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "application/javascript",
	".mjs":   "application/javascript",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".ico":   "image/x-icon",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".ttf":   "font/ttf",
	".webp":  "image/webp",
	".txt":   "text/plain; charset=utf-8",
}

func detectContentType(filePath string) string {
	ext := strings.ToLower(path.Ext(filePath))
	if ct, ok := customMimeTypes[ext]; ok {
		return ct
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// Handler wraps an existing http.Handler to serve embedded SPA static assets and HTML fallback.
type Handler struct {
	next   http.Handler
	assets fs.FS
}

// NewHandler creates a new SPA handler wrapping next with assets.
func NewHandler(next http.Handler, assets fs.FS) http.Handler {
	return &Handler{
		next:   next,
		assets: assets,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Only GET and HEAD requests can serve static files or SPA fallback.
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		h.next.ServeHTTP(w, r)
		return
	}

	// API and health endpoints must never fall back to SPA.
	reqPath := r.URL.Path
	if reqPath == "/api" || strings.HasPrefix(reqPath, "/api/") ||
		reqPath == "/healthz" || reqPath == "/readyz" {
		h.next.ServeHTTP(w, r)
		return
	}

	// Detect path traversal attempts across Path, RawPath, RequestURI, and unescaped path.
	raw := r.URL.RawPath
	if raw == "" {
		raw = reqPath
	}
	uri := r.RequestURI
	lowerRaw := strings.ToLower(raw)
	lowerURI := strings.ToLower(uri)
	if strings.Contains(reqPath, "..") || strings.Contains(raw, "..") || strings.Contains(uri, "..") ||
		strings.Contains(lowerRaw, "%2e%2e") || strings.Contains(lowerURI, "%2e%2e") ||
		strings.Contains(reqPath, "\\") || strings.Contains(lowerRaw, "%5c") || strings.Contains(lowerURI, "%5c") {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}

	// Clean path relative to root.
	clean := strings.TrimPrefix(path.Clean("/"+reqPath), "/")
	if clean == "." {
		clean = ""
	}

	// Reject dotfiles (any segment starting with a dot).
	for _, seg := range strings.Split(clean, "/") {
		if strings.HasPrefix(seg, ".") && seg != "" {
			http.NotFound(w, r)
			return
		}
	}

	// Root path: serve index.html.
	if clean == "" {
		if data, ok := readFile(h.assets, "index.html"); ok {
			serveBytes(w, r, data, "text/html; charset=utf-8", "no-cache")
			return
		}
		h.next.ServeHTTP(w, r)
		return
	}

	// Assets under /assets/* must be exact static files; never fall back to index.html.
	if clean == "assets" || strings.HasPrefix(clean, "assets/") {
		if data, ok := readFile(h.assets, clean); ok {
			serveBytes(w, r, data, detectContentType(clean), "public, max-age=31536000, immutable")
			return
		}
		http.NotFound(w, r)
		return
	}

	// Files with an extension are static file requests; do not fall back to index.html if missing.
	if path.Ext(clean) != "" {
		if data, ok := readFile(h.assets, clean); ok {
			cachePolicy := "no-cache"
			if strings.HasPrefix(clean, "assets/") {
				cachePolicy = "public, max-age=31536000, immutable"
			}
			serveBytes(w, r, data, detectContentType(clean), cachePolicy)
			return
		}
		http.NotFound(w, r)
		return
	}

	// Path without extension: check for exact match first.
	if data, ok := readFile(h.assets, clean); ok {
		serveBytes(w, r, data, detectContentType(clean), "no-cache")
		return
	}

	// Browser route fallback: serve index.html with no-cache.
	if data, ok := readFile(h.assets, "index.html"); ok {
		serveBytes(w, r, data, "text/html; charset=utf-8", "no-cache")
		return
	}

	// No embedded index.html present; delegate to next.
	h.next.ServeHTTP(w, r)
}

func readFile(assets fs.FS, name string) ([]byte, bool) {
	if assets == nil {
		return nil, false
	}
	f, err := assets.Open(name)
	if err != nil {
		return nil, false
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil || stat.IsDir() {
		return nil, false
	}

	data, err := io.ReadAll(f)
	if err != nil {
		return nil, false
	}
	return data, true
}

func serveBytes(w http.ResponseWriter, r *http.Request, data []byte, contentType, cacheControl string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Cache-Control", cacheControl)
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}
