//go:build windows

package lifecycle

import "syscall"

const createNewProcessGroup = 0x00000200

func detachedProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
}
