package httpapi

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Serves the built React app (web/dist) from the API's own origin when
// WEB_DIR is set (production). Copied from followup-portal.

// serveWeb returns the router's NotFound handler: static files when they
// exist, index.html for everything else so client-side routes survive a
// refresh or a pasted deep link.
func (s *Server) serveWeb() http.HandlerFunc {
	root := http.Dir(s.webDir)
	files := http.FileServer(root)

	return func(w http.ResponseWriter, r *http.Request) {
		// An unmatched /api path stays JSON. Falling through to index.html
		// would answer a fetch() with 200 and an HTML body, turning a typo'd
		// endpoint into a parse error instead of a 404.
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}

		name := path.Clean("/" + r.URL.Path)
		f, err := root.Open(name)
		if err != nil {
			s.serveIndex(w, r)
			return
		}
		defer f.Close()
		if info, statErr := f.Stat(); statErr != nil || info.IsDir() {
			s.serveIndex(w, r)
			return
		}

		// Vite fingerprints everything under /assets/, so those are safe to
		// cache forever. Anything else — index.html above all — must be
		// revalidated, or a deploy leaves browsers on the previous build.
		if strings.HasPrefix(name, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	}
}

func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request) {
	f, err := os.Open(filepath.Join(s.webDir, "index.html"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "index.html", info.ModTime(), f)
}
