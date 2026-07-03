package cmd

import (
	"context"
	"errors"
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
	// Fix 2: reject calls after Close so we never cache a store that will never be closed.
	if p.closed {
		p.mu.Unlock()
		return storeEntry{}, errors.New("connpool closed")
	}
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

	// Fix 1: after the open (which runs outside the lock), verify the slot is
	// still the current entry for this id AND the pool is still open. If it was
	// evicted or the pool was closed while we were opening, close the freshly
	// opened store immediately to avoid a connection leak.
	p.mu.Lock()
	current, stillPresent := p.slots[id]
	evicted := p.closed || !stillPresent || current != slot
	if evicted {
		delete(p.slots, id) // no-op if already gone, harmless otherwise
	}
	p.mu.Unlock()

	if evicted {
		_ = st.Close()
		slot.err = errors.New("connpool: store evicted or pool closed during open")
		close(slot.done)
		return storeEntry{}, slot.err
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
	if !ok {
		return
	}
	// Fix 3: an open may still be in flight for this slot — openOrGet writes
	// slot.store outside the lock, after its Fix 1 re-check. Wait for the open
	// to finish (as Close does) before reading slot.store; otherwise we race
	// with that write and, if we observe nil, leak the freshly opened store,
	// which is no longer in the map for Close to reach. If the open is still
	// before its Fix 1 re-check, it will see the slot gone, close the store
	// itself, and close done.
	<-slot.done
	if slot.store != nil {
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
