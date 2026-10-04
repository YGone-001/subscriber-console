package spa

import (
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
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

var appRoutePrefixes = map[string]bool{
	"login":         true,
	"ocs":           true,
	"profile":       true,
	"rating":        true,
	"roles":         true,
	"subscribers":   true,
	"system-health": true,
	"users":         true,
}

func isApplicationRoute(cleanPath string) bool {
	if cleanPath == "" {
		return true
	}
	parts := strings.Split(cleanPath, "/")
	first := parts[0]
	return appRoutePrefixes[first]
}

func hasPathTraversal(r *http.Request) bool {
	if strings.Contains(r.URL.Path, "\\") || strings.Contains(r.URL.RawPath, "\\") || strings.Contains(r.RequestURI, "\\") {
		return true
	}
	rawURI := r.RequestURI
	if idx := strings.IndexByte(rawURI, '?'); idx != -1 {
		rawURI = rawURI[:idx]
	}
	lowerURI := strings.ToLower(rawURI)
	if strings.Contains(lowerURI, "%5c") {
		return true
	}

	candidates := []string{r.URL.Path, r.URL.RawPath, rawURI}
	for _, cand := range candidates {
		if cand == "" {
			continue
		}
		normalized := strings.ReplaceAll(cand, "%2f", "/")
		normalized = strings.ReplaceAll(normalized, "%2F", "/")
		segments := strings.Split(normalized, "/")
		for _, seg := range segments {
			if seg == ".." {
				return true
			}
			u1, err := url.PathUnescape(seg)
			if err == nil {
				if u1 == ".." {
					return true
				}
				if u2, err2 := url.PathUnescape(u1); err2 == nil && u2 == ".." {
					return true
				}
			}
		}
	}
	return false
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

	// Reject genuine path traversal.
	if hasPathTraversal(r) {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}

	// Reserved namespaces must never fall back to SPA.
	reqPath := r.URL.Path
	if reqPath == "/api" || strings.HasPrefix(reqPath, "/api/") ||
		reqPath == "/healthz" || reqPath == "/readyz" {
		h.next.ServeHTTP(w, r)
		return
	}

	clean := strings.TrimPrefix(path.Clean("/"+reqPath), "/")
	if clean == "." {
		clean = ""
	}

	// Handle /assets/* as exact static-resource namespace.
	if clean == "assets" || strings.HasPrefix(clean, "assets/") {
		if data, ok := readFile(h.assets, clean); ok {
			serveBytes(w, r, data, detectContentType(clean), "public, max-age=31536000, immutable")
			return
		}
		http.NotFound(w, r)
		return
	}

	// If this is an application browser route, serve index.html.
	if isApplicationRoute(clean) {
		if data, ok := readFile(h.assets, "index.html"); ok {
			serveBytes(w, r, data, "text/html; charset=utf-8", "no-cache")
			return
		}
		h.next.ServeHTTP(w, r)
		return
	}

	// Protect direct embedded dotfiles/control files (e.g. /.gitignore, /.env).
	for _, seg := range strings.Split(clean, "/") {
		if strings.HasPrefix(seg, ".") && seg != "" {
			http.NotFound(w, r)
			return
		}
	}

	// If an exact embedded public/static file exists, serve it.
	if data, ok := readFile(h.assets, clean); ok {
		serveBytes(w, r, data, detectContentType(clean), "no-cache")
		return
	}

	// If the request has an explicit file extension and was not found, return 404.
	if path.Ext(clean) != "" {
		http.NotFound(w, r)
		return
	}

	// Non-extension browser route fallback.
	if data, ok := readFile(h.assets, "index.html"); ok {
		serveBytes(w, r, data, "text/html; charset=utf-8", "no-cache")
		return
	}

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
