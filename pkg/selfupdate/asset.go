package selfupdate

import (
	"fmt"
	"strings"
)

// assetName reproduces the GoReleaser name_template for a release archive:
//
//	dev-dashboard_{num}_{os}_{arch}.tar.gz   (.zip on windows)
//
// where num is the version without a leading "v".
func assetName(version, goos, goarch string) string {
	num := strings.TrimPrefix(strings.TrimSpace(version), "v")
	ext := "tar.gz"
	if goos == "windows" {
		ext = "zip"
	}
	return fmt.Sprintf("dev-dashboard_%s_%s_%s.%s", num, goos, goarch, ext)
}
