package spa

import (
	"embed"
	"io/fs"
)

//go:embed all:static
var staticFiles embed.FS

// EmbeddedFS returns the embedded filesystem rooted at the static directory.
func EmbeddedFS() fs.FS {
	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		return staticFiles
	}
	return sub
}
