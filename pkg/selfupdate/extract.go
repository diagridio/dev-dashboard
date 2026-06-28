package selfupdate

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
)

// binaryFileName returns the name of the dev-dashboard binary inside a release
// archive for the given OS.
func binaryFileName(goos string) string {
	if goos == "windows" {
		return "dev-dashboard.exe"
	}
	return "dev-dashboard"
}

// extractBinary pulls the dev-dashboard binary bytes out of a release archive:
// a .zip on windows, a .tar.gz elsewhere.
func extractBinary(archive []byte, goos string) ([]byte, error) {
	name := binaryFileName(goos)
	if goos == "windows" {
		return extractFromZip(archive, name)
	}
	return extractFromTarGz(archive, name)
}

func extractFromTarGz(archive []byte, name string) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open gzip: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read tar: %w", err)
		}
		if hdr.Name == name {
			return io.ReadAll(tr)
		}
	}
	return nil, fmt.Errorf("binary %q not found in archive", name)
}

func extractFromZip(archive []byte, name string) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, fmt.Errorf("open zip: %w", err)
	}
	for _, f := range zr.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				return nil, fmt.Errorf("open zip entry: %w", err)
			}
			defer rc.Close()
			return io.ReadAll(rc)
		}
	}
	return nil, fmt.Errorf("binary %q not found in archive", name)
}
