package discovery

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"sigs.k8s.io/yaml"
)

// composeFileServices is the minimal compose-file subset we consume: only
// each service's build key, which compose allows as either a string
// (context shorthand) or an object. sigs.k8s.io/yaml converts YAML to JSON
// first, so json tags and json.RawMessage apply.
type composeFileServices struct {
	Services map[string]struct {
		Build json.RawMessage `json:"build,omitempty"`
	} `json:"services"`
}

// runtimeFromBuildContext infers the app language from marker files in the
// service's local build context, located via the compose project labels
// (com.docker.compose.project.config_files / .working_dir). configFiles is
// the raw label value — comma-separated when the project was started with
// multiple -f files; the first file that yields a runtime wins. Best-effort:
// any failure (missing/foreign compose file, YAML error, no build section,
// unreadable dir) yields "unknown". Display-only enrichment — discovery
// correctness never depends on it (see the design doc for why compose-file
// parsing is otherwise avoided).
func runtimeFromBuildContext(configFiles, workingDir, service string) string {
	if configFiles == "" || service == "" {
		return "unknown"
	}

	parts := strings.Split(configFiles, ",")

	// Try each comma-separated part. If it fails and there's a next part,
	// try merging with the next part (handles paths that contain commas).
	for i := 0; i < len(parts); {
		cf := strings.TrimSpace(parts[i])

		dir, ok := buildContextDir(cf, workingDir, service)
		if ok {
			if rt := runtimeFromMarkerFiles(dir); rt != "unknown" {
				return rt
			}
			i++
			continue
		}

		// If this part failed and there's a next part, try merging
		if i+1 < len(parts) {
			mergedCF := cf + "," + strings.TrimSpace(parts[i+1])
			dir, ok := buildContextDir(mergedCF, workingDir, service)
			if ok {
				if rt := runtimeFromMarkerFiles(dir); rt != "unknown" {
					return rt
				}
				// Skip the next part since we merged it
				i += 2
				continue
			}
		}

		i++
	}

	return "unknown"
}

// buildContextDir resolves the local build-context directory for service
// from one compose file, or ok=false when it cannot.
func buildContextDir(configFile, workingDir, service string) (string, bool) {
	data, err := os.ReadFile(configFile)
	if err != nil {
		return "", false
	}
	var doc composeFileServices
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return "", false
	}
	svc, ok := doc.Services[service]
	if !ok || len(svc.Build) == 0 {
		return "", false
	}
	var ctx string
	if err := json.Unmarshal(svc.Build, &ctx); err != nil {
		var obj struct {
			Context string `json:"context"`
		}
		if err := json.Unmarshal(svc.Build, &obj); err != nil {
			return "", false
		}
		ctx = obj.Context
	}
	if ctx == "" {
		ctx = "."
	}
	if !filepath.IsAbs(ctx) {
		base := workingDir
		if base == "" {
			base = filepath.Dir(configFile)
		}
		ctx = filepath.Join(base, ctx)
	}
	return ctx, true
}

// runtimeFromMarkerFiles inspects the top level of dir for well-known
// project marker files. Markers are checked in a fixed priority order (not
// directory order) so polyglot contexts resolve deterministically —
// package.json last, since it shows up in many non-Node repos.
func runtimeFromMarkerFiles(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "unknown"
	}
	names := map[string]bool{}
	dotnetProj := false
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := strings.ToLower(e.Name())
		names[n] = true
		if strings.HasSuffix(n, ".csproj") || strings.HasSuffix(n, ".fsproj") || strings.HasSuffix(n, ".sln") {
			dotnetProj = true
		}
	}
	switch {
	case names["go.mod"]:
		return "go"
	case dotnetProj, names["global.json"]:
		return "dotnet"
	case names["cargo.toml"]:
		return "rust"
	case names["pom.xml"], names["build.gradle"], names["build.gradle.kts"]:
		return "java"
	case names["pyproject.toml"], names["requirements.txt"], names["setup.py"]:
		return "python"
	case names["package.json"]:
		return "node"
	}
	return "unknown"
}
