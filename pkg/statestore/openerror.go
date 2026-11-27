package statestore

import (
	"errors"
	"fmt"
)

// OpenError describes a known store the dashboard could not open. It matches
// Kind (the caller's "store unreachable" sentinel) and Cause with errors.Is,
// and its message names the real reason: an unsupported type is reported as
// such rather than as a connection failure, and the connection summary is
// left out when there is none (it is empty for unsupported types).
type OpenError struct {
	Kind  error
	Name  string
	Conn  string
	Cause error
}

func (e *OpenError) Error() string {
	if errors.Is(e.Cause, ErrUnsupported) {
		return fmt.Sprintf("state store %q can't be read directly: %v", e.Name, e.Cause)
	}
	msg := fmt.Sprintf("%v %q", e.Kind, e.Name)
	if e.Conn != "" {
		msg += " (" + e.Conn + ")"
	}
	if e.Cause != nil {
		msg += ": " + e.Cause.Error()
	}
	return msg
}

func (e *OpenError) Unwrap() []error {
	if e.Cause == nil {
		return []error{e.Kind}
	}
	return []error{e.Kind, e.Cause}
}
