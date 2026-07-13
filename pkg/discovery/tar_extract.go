package discovery

import (
	"archive/tar"
	"bytes"
	"io"
	"path"
	"strings"
)

const (
	// maxExtractFiles bounds how many YAML files are read from one
	// container's resources dir; maxExtractFileSize bounds each file.
	maxExtractFiles    = 32
	maxExtractFileSize = 1 << 20 // 1 MiB
)

// extractYAMLFromTar reads a `docker cp <id>:<dir> -` tar stream and returns
// its regular .yaml/.yml members (member path -> content). Oversized members
// and non-YAML files are skipped silently; a corrupt archive errors.
func extractYAMLFromTar(tarBytes []byte) (map[string][]byte, error) {
	tr := tar.NewReader(bytes.NewReader(tarBytes))
	out := map[string][]byte{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		name := path.Clean(hdr.Name)
		ext := strings.ToLower(path.Ext(name))
		if ext != ".yaml" && ext != ".yml" {
			continue
		}
		if hdr.Size > maxExtractFileSize {
			continue
		}
		if len(out) >= maxExtractFiles {
			break
		}
		data, err := io.ReadAll(io.LimitReader(tr, maxExtractFileSize+1))
		if err != nil {
			return nil, err
		}
		out[name] = data
	}
	return out, nil
}
