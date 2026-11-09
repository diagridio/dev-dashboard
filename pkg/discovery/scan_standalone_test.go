//go:build unit

package discovery

import (
	"errors"
	"testing"

	"github.com/dapr/cli/pkg/standalone"
	"github.com/stretchr/testify/require"
)

func TestStandaloneScannerReadsConfigPerDaprd(t *testing.T) {
	list := func() ([]standalone.ListOutput, error) {
		return []standalone.ListOutput{
			{AppID: "a", DaprdPID: 42},
			{AppID: "b", DaprdPID: 43},
		}, nil
	}
	var called []int
	config := func(pid int) string {
		called = append(called, pid)
		if pid == 42 {
			return "/proj/a.yaml"
		}
		return ""
	}

	results, err := newStandaloneScanner(list, config)()
	require.NoError(t, err)
	require.Len(t, results, 2)
	require.Equal(t, "/proj/a.yaml", results[0].ConfigPath)
	require.Empty(t, results[1].ConfigPath)
	require.Equal(t, []int{42, 43}, called)
}

func TestStandaloneScannerListError(t *testing.T) {
	boom := errors.New("boom")
	list := func() ([]standalone.ListOutput, error) { return nil, boom }
	config := func(int) string {
		t.Fatal("daprdConfig must not be called when listing fails")
		return ""
	}

	_, err := newStandaloneScanner(list, config)()
	require.ErrorIs(t, err, boom)
}
