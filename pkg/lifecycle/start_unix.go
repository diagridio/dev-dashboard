//go:build !windows

package lifecycle

import "syscall"

// detachedProcAttr puts the child in its own process group so it survives the
// dashboard and never receives the dashboard's terminal signals.
func detachedProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }
