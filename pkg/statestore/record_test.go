//go:build unit

package statestore

import (
	"testing"
	"time"

	"github.com/dapr/components-contrib/state"
	"github.com/stretchr/testify/require"
)

func strPtr(s string) *string { return &s }

func TestRecordsFromBulk(t *testing.T) {
	t.Run("maps value, etag and content type", func(t *testing.T) {
		got := recordsFromBulk([]state.BulkGetResponse{{
			Key:         "app||order-1",
			Data:        []byte(`{"id":1}`),
			ETag:        strPtr("7"),
			ContentType: strPtr("application/json"),
		}})
		require.Len(t, got, 1)
		require.Equal(t, "app||order-1", got[0].Key)
		require.Equal(t, `{"id":1}`, string(got[0].Value))
		require.Equal(t, "7", got[0].ETag)
		require.Equal(t, "application/json", got[0].ContentType)
		require.Nil(t, got[0].TTLExpire)
	})

	t.Run("parses ttlExpireTime into TTLExpire", func(t *testing.T) {
		got := recordsFromBulk([]state.BulkGetResponse{{
			Key:  "app||k",
			Data: []byte("v"),
			Metadata: map[string]string{
				state.GetRespMetaKeyTTLExpireTime: "2026-08-26T14:02:11Z",
			},
		}})
		require.Len(t, got, 1)
		require.NotNil(t, got[0].TTLExpire)
		require.Equal(t, time.Date(2026, 8, 26, 14, 2, 11, 0, time.UTC), got[0].TTLExpire.UTC())
	})

	t.Run("ignores an unparseable ttlExpireTime rather than failing the record", func(t *testing.T) {
		got := recordsFromBulk([]state.BulkGetResponse{{
			Key:      "app||k",
			Data:     []byte("v"),
			Metadata: map[string]string{state.GetRespMetaKeyTTLExpireTime: "not-a-time"},
		}})
		require.Len(t, got, 1)
		require.Nil(t, got[0].TTLExpire)
	})

	t.Run("omits missing keys so a racing delete does not render an empty row", func(t *testing.T) {
		got := recordsFromBulk([]state.BulkGetResponse{
			{Key: "app||present", Data: []byte("v")},
			{Key: "app||gone"}, // backends fill in not-found keys with a bare Key
		})
		require.Len(t, got, 1)
		require.Equal(t, "app||present", got[0].Key)
	})

	t.Run("omits per-key errors", func(t *testing.T) {
		got := recordsFromBulk([]state.BulkGetResponse{
			{Key: "app||bad", Error: "decode failed"},
			{Key: "app||ok", Data: []byte("v")},
		})
		require.Len(t, got, 1)
		require.Equal(t, "app||ok", got[0].Key)
	})

	t.Run("keeps an empty-but-present value", func(t *testing.T) {
		got := recordsFromBulk([]state.BulkGetResponse{
			{Key: "app||empty", Data: []byte{}, ETag: strPtr("1")},
		})
		require.Len(t, got, 1)
		require.Empty(t, got[0].Value)
	})
}

// ccStore must satisfy RecordReader — the type assertion in
// cmd.buildStoreEntry silently degrades to "not browsable" if it ever stops.
func TestCCStoreImplementsRecordReader(t *testing.T) {
	var _ RecordReader = (*ccStore)(nil)
}
