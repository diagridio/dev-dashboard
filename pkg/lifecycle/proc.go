package lifecycle

import (
	"fmt"
	"os"
	"os/exec"

	gproc "github.com/shirou/gopsutil/process"
)

// ProcController isolates OS process operations so the manager is testable.
type ProcController interface {
	Snapshot(pid int) (ProcSnapshot, error)
	Terminate(pid int) error
	Kill(pid int) error
	Alive(pid int) bool
}

// Starter launches a captured command detached from the dashboard process.
type Starter interface {
	Start(argv []string, dir, logPath string) error
}

type gopsutilProc struct{}

// NewProcController returns the gopsutil-backed ProcController.
func NewProcController() ProcController { return gopsutilProc{} }

func (gopsutilProc) Snapshot(pid int) (ProcSnapshot, error) {
	p, err := gproc.NewProcess(int32(pid))
	if err != nil {
		return ProcSnapshot{}, fmt.Errorf("process %d: %w", pid, err)
	}
	argv, err := p.CmdlineSlice()
	if err != nil || len(argv) == 0 {
		return ProcSnapshot{}, fmt.Errorf("command line of %d unavailable: %w", pid, err)
	}
	dir, _ := p.Cwd() // best effort; "" runs the restart from the dashboard's cwd
	return ProcSnapshot{PID: pid, Argv: argv, Dir: dir}, nil
}

func (gopsutilProc) Terminate(pid int) error {
	p, err := gproc.NewProcess(int32(pid))
	if err != nil {
		return err
	}
	return p.Terminate()
}

func (gopsutilProc) Kill(pid int) error {
	p, err := gproc.NewProcess(int32(pid))
	if err != nil {
		return err
	}
	return p.Kill()
}

func (gopsutilProc) Alive(pid int) bool {
	ok, err := gproc.PidExists(int32(pid))
	return err == nil && ok
}

type execStarter struct{}

// NewStarter returns the exec-backed Starter.
func NewStarter() Starter { return execStarter{} }

func (execStarter) Start(argv []string, dir, logPath string) error {
	if len(argv) == 0 {
		return fmt.Errorf("empty command")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.SysProcAttr = detachedProcAttr()
	if logPath != "" {
		f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			cmd.Stdout, cmd.Stderr = f, f
			defer f.Close() // the child holds its own fd after Start
		}
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }() // reap; the process outlives the request
	return nil
}
