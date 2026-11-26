package actors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// maxBodyBytes caps how much of a daprd response body is read.
const maxBodyBytes = 1 << 20

// ErrInternalType is returned for Dapr internal actor types.
var ErrInternalType = errors.New("internal actor types can't be invoked")

// InvokeRequest is an actor method invocation.
type InvokeRequest struct {
	Method string `json:"method"`
	Verb   string `json:"verb"`
	Body   string `json:"body"`
}

// InvokeResult is what daprd answered for an invocation.
type InvokeResult struct {
	Status      int    `json:"status"`
	DurationMs  int64  `json:"durationMs"`
	ContentType string `json:"contentType"`
	Body        string `json:"body"`
	Error       string `json:"error,omitempty"`
}

// IsInternal reports whether actorType is a Dapr internal actor type.
func IsInternal(actorType string) bool {
	return strings.HasPrefix(actorType, "dapr.internal.")
}

// DaprdErrorMessage extracts a human-readable message from a daprd error
// response body, which is normally JSON of the form
// {"errorCode":"...","message":"..."}. It falls back to the error code, then
// the trimmed raw body, if the message field is empty or the body isn't the
// expected shape.
func DaprdErrorMessage(body []byte) string {
	var parsed struct {
		Message   string `json:"message"`
		ErrorCode string `json:"errorCode"`
	}
	if err := json.Unmarshal(body, &parsed); err == nil {
		if parsed.Message != "" {
			return parsed.Message
		}
		if parsed.ErrorCode != "" {
			return parsed.ErrorCode
		}
	}
	return strings.TrimSpace(string(body))
}

func actorURL(in discovery.Instance, actorType, actorID string, rest ...string) string {
	u := in.BaseURL() + "/v1.0/actors/" + url.PathEscape(actorType) + "/" + url.PathEscape(actorID)
	for _, s := range rest {
		u += "/" + url.PathEscape(s)
	}
	return u
}

// Invoke calls an actor method through the instance's sidecar. It returns an
// error only for problems before daprd answers; any daprd answer is a result.
// The caller owns the client's timeout.
func Invoke(ctx context.Context, client *http.Client, in discovery.Instance, actorType, actorID string, r InvokeRequest) (InvokeResult, error) {
	if IsInternal(actorType) {
		return InvokeResult{}, ErrInternalType
	}
	if r.Method == "" {
		return InvokeResult{}, errors.New("method is required")
	}
	verb := strings.ToUpper(r.Verb)
	if verb == "" {
		verb = http.MethodPost
	}
	switch verb {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete:
	default:
		return InvokeResult{}, fmt.Errorf("unsupported verb %q", r.Verb)
	}
	if !in.SidecarReachable {
		return InvokeResult{}, ErrSidecarUnreachable
	}
	req, err := http.NewRequestWithContext(ctx, verb, actorURL(in, actorType, actorID, "method", r.Method), strings.NewReader(r.Body))
	if err != nil {
		return InvokeResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return InvokeResult{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	dur := time.Since(start).Milliseconds()
	if err != nil {
		return InvokeResult{}, err
	}
	res := InvokeResult{
		Status:      resp.StatusCode,
		DurationMs:  dur,
		ContentType: resp.Header.Get("Content-Type"),
		Body:        string(body),
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		res.Error = DaprdErrorMessage(body)
	}
	return res, nil
}

// DeleteReminder deletes a reminder through the instance's sidecar.
func DeleteReminder(ctx context.Context, client *http.Client, in discovery.Instance, actorType, actorID, name string) error {
	if IsInternal(actorType) {
		return ErrInternalType
	}
	if name == "" {
		return errors.New("reminder name is required")
	}
	if !in.SidecarReachable {
		return ErrSidecarUnreachable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, actorURL(in, actorType, actorID, "reminders", name), nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 200 && resp.StatusCode <= 299 {
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	return errors.New(DaprdErrorMessage(b))
}
