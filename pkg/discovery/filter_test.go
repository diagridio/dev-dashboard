//go:build unit

package discovery

import (
	"context"
	"errors"
	"testing"
)

type fakeFilterInner struct{ instances []Instance }

func (f fakeFilterInner) List(context.Context) ([]Instance, error) { return f.instances, nil }

func (f fakeFilterInner) Get(_ context.Context, key string) (Instance, error) {
	for _, in := range f.instances {
		if in.AppID == key {
			return in, nil
		}
	}
	return Instance{}, ErrNotFound
}

func newAspireFiltered() Service {
	return FilterAspire(fakeFilterInner{instances: []Instance{
		{AppID: "checkout", IsAspire: true},
		{AppID: "plain-daprd", IsAspire: false},
	}})
}

func TestFilterAspireListKeepsOnlyAspire(t *testing.T) {
	got, err := newAspireFiltered().List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].AppID != "checkout" {
		t.Fatalf("want only the aspire instance, got %+v", got)
	}
}

func TestFilterAspireGet(t *testing.T) {
	svc := newAspireFiltered()
	if _, err := svc.Get(context.Background(), "checkout"); err != nil {
		t.Fatalf("aspire instance must resolve: %v", err)
	}
	if _, err := svc.Get(context.Background(), "plain-daprd"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-aspire instance must be ErrNotFound, got %v", err)
	}
	if _, err := svc.Get(context.Background(), "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown key must stay ErrNotFound, got %v", err)
	}
}
