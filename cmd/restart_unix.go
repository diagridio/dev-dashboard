//go:build !windows

package cmd

import (
	"os"
	"syscall"
)

// restartSelf replaces the current process with exe, keeping the same
// arguments and environment. It only returns on failure.
func restartSelf(exe string, args []string) error {
	return syscall.Exec(exe, args, os.Environ())
}
