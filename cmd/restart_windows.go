//go:build windows

package cmd

import (
	"os"
	"os/exec"
)

// restartSelf starts exe as a child with the same arguments and inherited
// stdio (Windows has no execve), waits for it, then exits with its code. It
// only returns on failure to start.
func restartSelf(exe string, args []string) error {
	cmd := exec.Command(exe, args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := cmd.Wait(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		return err
	}
	os.Exit(0)
	return nil
}
