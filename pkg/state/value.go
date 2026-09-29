package state

import (
	"encoding/base64"
	"strings"
	"unicode/utf8"
)

// renderValue turns raw bytes into a JSON-safe string. Valid UTF-8 passes
// through as text; anything else (a protobuf blob, a gzip payload) is base64
// encoded so it cannot corrupt the response.
func renderValue(b []byte) (string, string) {
	if utf8.Valid(b) {
		return string(b), EncodingText
	}
	return base64.StdEncoding.EncodeToString(b), EncodingBase64
}

// preview reduces a rendered value to one short table-row line: whitespace runs
// collapse to single spaces, then the result is cut to previewChars runes with
// a trailing ellipsis. Counting runes rather than bytes keeps multibyte text
// intact.
func preview(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= previewChars {
		return s
	}
	r := []rune(s)
	return string(r[:previewChars]) + "…"
}

// truncateValue caps a rendered value at maxValueBytes, backing off to the
// previous rune boundary so the result stays valid UTF-8. The bool reports
// whether anything was cut.
func truncateValue(s string) (string, bool) {
	if len(s) <= maxValueBytes {
		return s, false
	}
	s = s[:maxValueBytes]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s, true
}
