package logs

import (
	"context"
	"io"
	"os"
	"strings"
	"time"
)

// Tail streams a log file: first up to backfillLines of the existing tail, then
// each newly-appended line, on the returned channel. The channel is closed when
// ctx is cancelled or an unrecoverable read error occurs. Returns an error if the
// file cannot be opened. pollInterval controls how often appended bytes are polled.
func Tail(ctx context.Context, path string, backfillLines int, pollInterval time.Duration) (<-chan string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	// Read the entire file for backfill using the same descriptor (no TOCTOU).
	data, err := io.ReadAll(f)
	if err != nil {
		f.Close()
		return nil, err
	}

	// Split into lines; strings.Split("a\nb\n", "\n") → ["a","b",""] — drop trailing empty.
	allLines := strings.Split(string(data), "\n")
	if len(allLines) > 0 && allLines[len(allLines)-1] == "" {
		allLines = allLines[:len(allLines)-1]
	}

	// Keep only the last backfillLines.
	if len(allLines) > backfillLines {
		allLines = allLines[len(allLines)-backfillLines:]
	}

	// Track current EOF offset so the poll loop starts after the backfilled content.
	offset := int64(len(data))

	ch := make(chan string, 64)

	go func() {
		defer f.Close()
		defer close(ch)

		// Emit backfill lines.
		for _, line := range allLines {
			select {
			case ch <- line:
			case <-ctx.Done():
				return
			}
		}

		// Poll for appended bytes.
		ticker := time.NewTicker(pollInterval)
		defer ticker.Stop()

		var carry []byte
		buf := make([]byte, 32*1024)

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// Detect in-place truncation/rotation (e.g. copytruncate): if the
				// file shrank below our offset, restart from the beginning and drop
				// any partial line carried over from the old content.
				if fi, serr := f.Stat(); serr == nil && fi.Size() < offset {
					offset = 0
					carry = nil
				}

				n, rerr := f.ReadAt(buf, offset)
				if n == 0 {
					if rerr != nil && rerr != io.EOF {
						return
					}
					continue
				}

				chunk := append(carry, buf[:n]...)
				carry = nil
				offset += int64(n)

				parts := strings.Split(string(chunk), "\n")
				// The last element is either "" (if chunk ends with \n) or a partial line.
				for i, part := range parts {
					if i == len(parts)-1 {
						// Last segment: only emit if it's complete (i.e. chunk ended with \n).
						if part != "" {
							carry = []byte(part)
						}
						// If part == "", chunk ended with \n — nothing to carry.
					} else {
						select {
						case ch <- part:
						case <-ctx.Done():
							return
						}
					}
				}
			}
		}
	}()

	return ch, nil
}
