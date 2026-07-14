package discovery

import "context"

// FilterAspire restricts a Service to Aspire-managed instances. Aspire host
// mode (dashboard on the host, no env contract) scans the full process table
// — IsAspire is only known after enrichment (the DCP-proxy heuristic in
// appproc.go), so the filter must wrap the Service rather than the Scanner.
// Wrap the outermost Service (after the lifecycle overlay) so every consumer
// — apps API, workflows, state-store election — sees the filtered view.
func FilterAspire(inner Service) Service { return aspireOnly{inner: inner} }

type aspireOnly struct{ inner Service }

func (a aspireOnly) List(ctx context.Context) ([]Instance, error) {
	all, err := a.inner.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Instance, 0, len(all))
	for _, in := range all {
		if in.IsAspire {
			out = append(out, in)
		}
	}
	return out, nil
}

func (a aspireOnly) Get(ctx context.Context, key string) (Instance, error) {
	in, err := a.inner.Get(ctx, key)
	if err != nil {
		return Instance{}, err
	}
	if !in.IsAspire {
		return Instance{}, ErrNotFound
	}
	return in, nil
}
