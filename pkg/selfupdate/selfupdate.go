package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/version"
)

const defaultRepo = "diagridio/dev-dashboard"

// Updater performs an in-place self-update from GitHub Releases. The base URLs,
// HTTP client, platform, current version, and target path are all injectable so
// the update flow is fully testable.
type Updater struct {
	Repo           string
	APIBase        string
	DownloadBase   string
	HTTP           *http.Client
	GOOS           string
	GOARCH         string
	CurrentVersion string
	ExecPath       string
	Out            io.Writer
}

// Result describes the outcome of an update.
type Result struct {
	From    string
	To      string
	Skipped bool // true when already on the requested/latest version
}

// New returns an Updater wired to the real GitHub endpoints and the currently
// running binary.
func New() (*Updater, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("locate executable: %w", err)
	}
	return &Updater{
		Repo:           defaultRepo,
		APIBase:        "https://api.github.com",
		DownloadBase:   "https://github.com",
		HTTP:           &http.Client{Timeout: 60 * time.Second},
		GOOS:           runtime.GOOS,
		GOARCH:         runtime.GOARCH,
		CurrentVersion: version.Get().Version,
		ExecPath:       exe,
		Out:            os.Stderr,
	}, nil
}

// Run resolves, downloads, verifies, and installs the requested version (empty
// means the latest release). It is a no-op when no explicit version is given
// and the binary is already on the latest version.
func (u *Updater) Run(ctx context.Context, requested string) (Result, error) {
	var target string
	if requested == "" {
		fmt.Fprintln(u.Out, "resolving latest…")
		v, err := resolveLatest(ctx, u.HTTP, u.APIBase, u.Repo)
		if err != nil {
			return Result{}, err
		}
		target = v
		if versionsEqual(target, u.CurrentVersion) {
			fmt.Fprintf(u.Out, "already up to date (%s)\n", target)
			return Result{From: u.CurrentVersion, To: target, Skipped: true}, nil
		}
	} else {
		target = normalizeVersion(requested)
	}

	name := assetName(target, u.GOOS, u.GOARCH)
	base := fmt.Sprintf("%s/%s/releases/download/%s", u.DownloadBase, u.Repo, target)
	archiveURL := base + "/" + name
	checksumsURL := base + "/checksums.txt"

	fmt.Fprintf(u.Out, "downloading dev-dashboard %s (%s/%s)…\n", target, u.GOOS, u.GOARCH)
	archive, err := httpGet(ctx, u.HTTP, archiveURL)
	if err != nil {
		if errors.Is(err, errNotFound) {
			return Result{}, fmt.Errorf("release %s not found for %s/%s", target, u.GOOS, u.GOARCH)
		}
		return Result{}, fmt.Errorf("download %s: %w", name, err)
	}
	sums, err := httpGet(ctx, u.HTTP, checksumsURL)
	if err != nil {
		return Result{}, fmt.Errorf("download checksums: %w", err)
	}

	fmt.Fprintln(u.Out, "verifying checksum…")
	if err := verifyChecksum(archive, name, string(sums)); err != nil {
		return Result{}, err
	}

	bin, err := extractBinary(archive, u.GOOS)
	if err != nil {
		return Result{}, err
	}

	path := u.ExecPath
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	fmt.Fprintf(u.Out, "installing to %s…\n", path)
	if err := replaceExecutable(path, bin); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return Result{}, fmt.Errorf("cannot write %s: permission denied — re-run the install script or use sudo: %w", path, err)
		}
		return Result{}, err
	}

	fmt.Fprintf(u.Out, "updated %s → %s (restart to use it)\n", u.CurrentVersion, target)
	return Result{From: u.CurrentVersion, To: target}, nil
}
