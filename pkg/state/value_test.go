//go:build unit

package state

import (
	"encoding/base64"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

func TestRenderValue(t *testing.T) {
	t.Run("valid utf-8 is returned as text", func(t *testing.T) {
		got, enc := renderValue([]byte(`{"id":1,"name":"café"}`))
		require.Equal(t, `{"id":1,"name":"café"}`, got)
		require.Equal(t, EncodingText, enc)
	})
	t.Run("invalid utf-8 is base64 so it cannot corrupt the JSON response", func(t *testing.T) {
		raw := []byte{0x00, 0xff, 0xfe, 0x01}
		got, enc := renderValue(raw)
		require.Equal(t, base64.StdEncoding.EncodeToString(raw), got)
		require.Equal(t, EncodingBase64, enc)
	})
	t.Run("empty value is text", func(t *testing.T) {
		got, enc := renderValue([]byte{})
		require.Equal(t, "", got)
		require.Equal(t, EncodingText, enc)
	})
}

func TestPreview(t *testing.T) {
	t.Run("short values pass through", func(t *testing.T) {
		require.Equal(t, `{"id":1}`, preview(`{"id":1}`))
	})
	t.Run("whitespace runs collapse so a multi-line blob stays on one row", func(t *testing.T) {
		require.Equal(t, `{ "id": 1 }`, preview("{\n  \"id\": 1\n}"))
	})
	t.Run("long values are truncated with an ellipsis", func(t *testing.T) {
		got := preview(strings.Repeat("a", previewChars+50))
		require.Equal(t, previewChars+1, utf8.RuneCountInString(got))
		require.True(t, strings.HasSuffix(got, "…"))
	})
	t.Run("truncation counts runes, not bytes, so multibyte text is not split", func(t *testing.T) {
		got := preview(strings.Repeat("é", previewChars+10))
		require.True(t, utf8.ValidString(got))
		require.Equal(t, previewChars+1, utf8.RuneCountInString(got))
	})
}

func TestTruncateValue(t *testing.T) {
	t.Run("under the cap is untouched", func(t *testing.T) {
		got, cut := truncateValue("small")
		require.Equal(t, "small", got)
		require.False(t, cut)
	})
	t.Run("over the cap is cut and flagged", func(t *testing.T) {
		got, cut := truncateValue(strings.Repeat("a", maxValueBytes+10))
		require.True(t, cut)
		require.Len(t, got, maxValueBytes)
	})
	t.Run("cut never splits a multibyte rune", func(t *testing.T) {
		// "é" is two bytes, so a byte-boundary cut at an odd cap would split it.
		got, cut := truncateValue(strings.Repeat("é", maxValueBytes))
		require.True(t, cut)
		require.True(t, utf8.ValidString(got), "truncated value must stay valid UTF-8")
		require.LessOrEqual(t, len(got), maxValueBytes)
	})
}
