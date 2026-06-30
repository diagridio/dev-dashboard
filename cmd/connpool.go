package cmd

import (
	"context"
	"net/http"
	"sync"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
)

// poolSlot is one cached identity. Its done channel implements per-identity
// single-flight: concurrent openOrGet callers for the same identity find the
// slot, then wait on done; the first caller runs the open outside the map lock.
type poolSlot struct {
	done  chan struct{}
	entry storeEntry
	store statestore.Store
	err   error
}

// connPool is a lazy, identity-keyed connection cache. It opens a store on first
// use, caches it for the session, and closes everything on Close. It never
// closes a connection just because the active store changed (retention).
type connPool struct {
	namespace string
	client    *http.Client
	apps      discovery.Service
	open      storeOpener

	mu     sync.Mutex
	slots  map[string]*poolSlot
	closed bool
}

// newConnPool builds a connPool. open == nil defaults to statestore.New.
func newConnPool(namespace string, client *http.Client, apps discovery.Service, open storeOpener) *connPool {
	if open == nil {
		open = statestore.New
	}
	return &connPool{
		namespace: namespace,
		client:    client,
		apps:      apps,
		open:      open,
		slots:     make(map[string]*poolSlot),
	}
}

// openOrGet returns the cached entry for c's identity, or opens it once. The
// open runs outside the map lock; concurrent callers for the same identity
// funnel through one open (per-identity single-flight). A failed open is not
// cached: the slot is removed so the next caller retries.
func (p *connPool) openOrGet(ctx context.Context, c statestore.Component) (storeEntry, error) {
	id := identity(&c)

	p.mu.Lock()
	if slot, ok := p.slots[id]; ok {
		p.mu.Unlock()
		<-slot.done
		return slot.entry, slot.err
	}
	slot := &poolSlot{done: make(chan struct{})}
	p.slots[id] = slot
	p.mu.Unlock()

	st, err := p.open(ctx, c)
	if err != nil {
		// Don't cache failures: drop the slot so a later select retries.
		p.mu.Lock()
		delete(p.slots, id)
		p.mu.Unlock()
		slot.err = err
		close(slot.done)
		return storeEntry{}, err
	}

	slot.store = st
	slot.entry = buildStoreEntry(st, p.namespace, p.client, p.apps)
	close(slot.done)
	return slot.entry, nil
}

// evict closes and removes the cached connection for c's identity, if present.
func (p *connPool) evict(c statestore.Component) {
	id := identity(&c)
	p.mu.Lock()
	slot, ok := p.slots[id]
	if ok {
		delete(p.slots, id)
	}
	p.mu.Unlock()
	if ok && slot.store != nil {
		_ = slot.store.Close()
	}
}

// Close closes every cached connection and prevents further caching.
func (p *connPool) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	slots := p.slots
	p.slots = make(map[string]*poolSlot)
	p.mu.Unlock()

	var err error
	for _, slot := range slots {
		<-slot.done
		if slot.store != nil {
			if e := slot.store.Close(); e != nil {
				err = e
			}
		}
	}
	return err
}
