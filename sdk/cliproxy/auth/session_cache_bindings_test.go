package auth

import (
	"testing"
	"time"
)

func bindingsByAuth(bindings []SessionBinding) map[string]int {
	counts := make(map[string]int)
	for _, b := range bindings {
		counts[b.AuthID]++
	}
	return counts
}

func TestSessionCacheBindingsListsLiveSessionsOncePerLogicalSession(t *testing.T) {
	cache := NewSessionCache(time.Hour)
	t.Cleanup(cache.Stop)
	cache.Set("s1", "auth-a")
	cache.Set("s2", "auth-b")
	cache.SetAliases("auth-a", "s3", "s3-alias") // two identifiers, one logical session

	bindings := cache.Bindings()

	if got := bindingsByAuth(bindings); len(bindings) != 3 || got["auth-a"] != 2 || got["auth-b"] != 1 {
		t.Fatalf("bindings = %+v, want 3 sessions (2 on auth-a, 1 on auth-b)", bindings)
	}
	for _, b := range bindings {
		if b.SessionID == "" || !b.ExpiresAt.After(time.Now()) {
			t.Fatalf("binding %+v lacks an id or a future expiry", b)
		}
	}
}

func TestSessionCacheBindingsDoesNotRefreshTTLs(t *testing.T) {
	cache := NewSessionCache(time.Hour)
	t.Cleanup(cache.Stop)
	cache.Set("s1", "auth-a")

	first := cache.Bindings()
	second := cache.Bindings()

	if len(first) != 1 || len(second) != 1 || !first[0].ExpiresAt.Equal(second[0].ExpiresAt) {
		t.Fatalf("reading bindings moved the expiry: %v -> %v", first, second)
	}
}

func TestSessionCacheBindingsSkipsExpiredAndOrdersNewestFirst(t *testing.T) {
	cache := NewSessionCache(time.Hour)
	t.Cleanup(cache.Stop)
	cache.Set("old", "auth-a")
	cache.Set("fresh", "auth-b")
	cache.Set("expired", "auth-c")

	cache.mu.Lock()
	for key, group := range cache.groups {
		switch key {
		case "old":
			group.expiresAt = time.Now().Add(time.Minute)
		case "expired":
			group.expiresAt = time.Now().Add(-time.Minute)
		}
		cache.groups[key] = group
	}
	cache.mu.Unlock()

	bindings := cache.Bindings()

	if len(bindings) != 2 || bindings[0].SessionID != "fresh" || bindings[1].SessionID != "old" {
		t.Fatalf("bindings = %+v, want [fresh old]: expired dropped, latest expiry first", bindings)
	}
}

func TestSessionCacheBindingsNilSafe(t *testing.T) {
	var cache *SessionCache
	if got := cache.Bindings(); got != nil {
		t.Fatalf("nil cache returned %v", got)
	}
	var selector *SessionAffinitySelector
	if got := selector.Bindings(); got != nil {
		t.Fatalf("nil selector returned %v", got)
	}
}

func TestSessionAffinitySelectorExposesItsBindings(t *testing.T) {
	selector := NewSessionAffinitySelectorWithConfig(SessionAffinityConfig{Fallback: &FillFirstSelector{}, TTL: time.Hour})
	t.Cleanup(selector.Stop)
	selector.cache.Set("s1", "auth-a")

	if got := selector.Bindings(); len(got) != 1 || got[0].AuthID != "auth-a" {
		t.Fatalf("selector bindings = %+v", got)
	}
}
