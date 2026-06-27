// Package logging builds the dashboard's diagnostic logger.
//
// Logging is opt-in: New(false) returns a logger that discards everything,
// New(true) returns a text logger writing to stderr at INFO level.
package logging

import (
	"context"
	"log/slog"
	"os"
)

// New returns the dashboard logger. When verbose is false the logger discards
// all output (no diagnostics are emitted). When true it writes text to stderr
// at INFO level (INFO/WARN/ERROR).
func New(verbose bool) *slog.Logger {
	if !verbose {
		return slog.New(discardHandler{})
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
}

// discardHandler is a slog.Handler that drops every record and reports disabled
// at all levels, so call sites become cheap no-ops when --verbose is off.
type discardHandler struct{}

func (discardHandler) Enabled(context.Context, slog.Level) bool  { return false }
func (discardHandler) Handle(context.Context, slog.Record) error { return nil }
func (d discardHandler) WithAttrs([]slog.Attr) slog.Handler      { return d }
func (d discardHandler) WithGroup(string) slog.Handler           { return d }
