package cliproxy

import (
	"context"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/quota"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func TestNormalizedRoutingRuntimeStateAcceptsExpirationFirst(t *testing.T) {
	for _, raw := range []string{"expiration-first", " Expiration-First ", "expirationfirst", "EF"} {
		cfg := &config.Config{}
		cfg.Routing.Strategy = raw
		if got := normalizedRoutingRuntimeState(cfg).strategy; got != "expiration-first" {
			t.Fatalf("strategy %q normalized to %q, want expiration-first", raw, got)
		}
	}
}

// observeWeeklyResets records that "a" resets in 6 days and "b" in 2 days.
func observeWeeklyResets(store *quota.Store) *quota.Store {
	now := time.Now()
	for id, days := range map[string]time.Duration{"a": 6, "b": 2} {
		store.Observe(id, "claude", quota.Observation{Windows: []quota.Window{
			{ID: quota.WindowWeekly, UsedPercent: 10, ResetsAt: now.Add(days * 24 * time.Hour)},
		}}, now, quota.SourceHeaders)
	}
	return store
}

func storeWithWeeklyResets() *quota.Store { return observeWeeklyResets(quota.NewStore()) }

func pickFromAB(t *testing.T, selector coreauth.Selector) string {
	t.Helper()
	got, err := selector.Pick(context.Background(), "claude", "", cliproxyexecutor.Options{}, []*coreauth.Auth{{ID: "a"}, {ID: "b"}})
	if err != nil {
		t.Fatalf("Pick() error = %v", err)
	}
	return got.ID
}

func TestNewRoutingSelectorExpirationFirstReadsTheQuotaStore(t *testing.T) {
	selector := newRoutingSelectorWithResets(routingRuntimeState{strategy: "expiration-first"}, storeWithWeeklyResets())
	if _, ok := selector.(*coreauth.ExpirationFirstSelector); !ok {
		t.Fatalf("selector = %T, want *ExpirationFirstSelector", selector)
	}
	if got := pickFromAB(t, selector); got != "b" {
		t.Fatalf("Pick() = %q, want b (weekly window resets first)", got)
	}
}

func TestNewRoutingSelectorExpirationFirstIsTheAffinityFallback(t *testing.T) {
	selector := newRoutingSelectorWithResets(routingRuntimeState{
		strategy: "expiration-first", sessionAffinity: true, sessionAffinityTTL: time.Minute,
		sessionAffinitySubagents: true, sessionAffinityRebindOn: coreauth.SessionAffinityRebindOnQuota,
	}, storeWithWeeklyResets())
	affinity, ok := selector.(*coreauth.SessionAffinitySelector)
	if !ok {
		t.Fatalf("selector = %T, want *SessionAffinitySelector", selector)
	}
	t.Cleanup(affinity.Stop)
	if got := pickFromAB(t, selector); got != "b" {
		t.Fatalf("a new session picked %q, want b from the expiration-first fallback", got)
	}
}

func TestNewRoutingSelectorKeepsTheOtherStrategies(t *testing.T) {
	if _, ok := newRoutingSelector(routingRuntimeState{strategy: "fill-first"}).(*coreauth.FillFirstSelector); !ok {
		t.Fatal("fill-first no longer builds a FillFirstSelector")
	}
	if _, ok := newRoutingSelector(routingRuntimeState{strategy: "round-robin"}).(*coreauth.RoundRobinSelector); !ok {
		t.Fatal("round-robin no longer builds a RoundRobinSelector")
	}
}

func TestResetSourceIsUntypedNilWithoutAQuotaStore(t *testing.T) {
	// A typed nil *quota.Store inside the interface would panic on first use.
	if source := (&Service{}).resetSource(); source != nil {
		t.Fatalf("resetSource() = %#v, want a nil interface", source)
	}
	if (&Service{quotaStore: quota.NewStore()}).resetSource() == nil {
		t.Fatal("resetSource() = nil, want the quota store")
	}
}

func TestApplyManagerConfigSwitchesToExpirationFirst(t *testing.T) {
	cfg := &config.Config{}
	cfg.Routing.Strategy = "expiration-first"
	svc := &Service{cfg: cfg, coreManager: coreauth.NewManager(nil, nil, nil), quotaStore: storeWithWeeklyResets()}

	if !svc.applyManagerConfig(context.Background(), configCommit{cfg: cfg, sequence: 1}) {
		t.Fatal("applyManagerConfig() = false")
	}
	if _, ok := svc.coreManager.Selector().(*coreauth.ExpirationFirstSelector); !ok {
		t.Fatalf("selector = %T, want *ExpirationFirstSelector", svc.coreManager.Selector())
	}
	if got := pickFromAB(t, svc.coreManager.Selector()); got != "b" {
		t.Fatalf("Pick() = %q, want b: the selector must read the service's quota store", got)
	}
}
