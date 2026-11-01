// Package vpxydash embeds the VPXY quota dashboard, an optz app built from dashboard/.
// Rebuild it with `bun run build` in dashboard/, which exports the app and copies index.html
// and assets/ into dist/ here.
package vpxydash

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

// FS returns the dashboard files: index.html and assets/.
func FS() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		// Unreachable: "dist" is a valid, embedded directory name.
		return files
	}
	return sub
}
