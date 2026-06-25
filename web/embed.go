// Package web embeds the built SPA assets.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distEmbed embed.FS

// DistFS returns the embedded SPA file system rooted at dist/.
func DistFS() (fs.FS, error) { return fs.Sub(distEmbed, "dist") }
