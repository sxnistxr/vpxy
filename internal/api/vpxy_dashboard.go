package api

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	configaccess "github.com/router-for-me/CLIProxyAPI/v8/internal/access/config_access"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/api/handlers/management"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/quota"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

const (
	// vpxyMinRefreshSpacing is the shortest gap between two dashboard refreshes of one target,
	// so a stuck button cannot hammer the upstream usage endpoints.
	vpxyMinRefreshSpacing = 5 * time.Second
	// vpxyRecentSessions caps how many live sessions each account lists.
	vpxyRecentSessions = 8
	// vpxySessionIDChars is how much of a session ID the dashboard shows.
	vpxySessionIDChars   = 8
	vpxyRefreshAll       = "all"
	vpxyMaxRefreshBody   = 4 << 10
	vpxyDefaultTTL       = time.Hour
	vpxyDefaultStrategy  = "round-robin"
	vpxyStatusReady      = "ready"
	vpxyStatusDisabled   = "disabled"
	vpxyStatusCooldown   = "cooldown"
	vpxyStatusLimited    = "limited"
	vpxyRebindOnAny      = auth.SessionAffinityRebindOnAny
	vpxyRebindOnQuota    = auth.SessionAffinityRebindOnQuota
	vpxyStrategyExpiry   = "expiration-first"
	vpxyStrategyFill     = "fill-first"
	vpxyStrategyWeighted = "weighted-round-robin"
)

// vpxyOverview is the payload of GET /vpxy/api/overview.
type vpxyOverview struct {
	GeneratedAt    time.Time             `json:"generated_at"`
	Routing        vpxyRouting           `json:"routing"`
	Monitor        vpxyMonitor           `json:"monitor"`
	Accounts       []vpxyAccount         `json:"accounts"`
	Totals         quota.CacheCounters   `json:"totals"`
	AffinityBreaks []quota.AffinityBreak `json:"affinity_breaks"`
}

// vpxyAccount is one Claude or Codex OAuth credential with its quota data and live sessions.
type vpxyAccount struct {
	quota.Account
	Label       string       `json:"label"`
	Priority    int          `json:"priority"`
	Status      string       `json:"status"`
	StatusUntil time.Time    `json:"status_until,omitzero"`
	Sessions    vpxySessions `json:"sessions"`
}

type vpxySessions struct {
	Count  int           `json:"count"`
	Recent []vpxySession `json:"recent"`
}

type vpxySession struct {
	ID               string `json:"id"`
	ExpiresInSeconds int64  `json:"expires_in_seconds"`
}

type vpxyRouting struct {
	Strategy          string `json:"strategy"`
	SessionAffinity   bool   `json:"session_affinity"`
	SessionTTLSeconds int64  `json:"session_ttl_seconds"`
	RebindOn          string `json:"rebind_on"`
	Sessions          int    `json:"sessions"`
}

type vpxyMonitor struct {
	PollingEnabled     bool  `json:"polling_enabled"`
	IntervalSeconds    int64 `json:"interval_seconds"`
	RebuildAlertTokens int64 `json:"rebuild_alert_tokens"`
	TrustedNetworks    bool  `json:"trusted_networks"`
}

// vpxyOverviewInput is everything buildVPXYOverview reads, gathered once per request.
type vpxyOverviewInput struct {
	Now      time.Time
	Config   *config.Config
	Auths    []*auth.Auth
	Accounts []quota.Account
	Bindings []auth.SessionBinding
	Breaks   []quota.AffinityBreak
}

// buildVPXYOverview merges the live credentials with the quota store. Only OAuth Claude and
// Codex credentials are listed; quota data for a credential that no longer exists is dropped.
func buildVPXYOverview(in vpxyOverviewInput) vpxyOverview {
	quotaByID := make(map[string]quota.Account, len(in.Accounts))
	for _, account := range in.Accounts {
		quotaByID[account.AuthID] = account
	}
	sessionsByID := make(map[string][]auth.SessionBinding)
	liveSessions := 0
	for _, binding := range in.Bindings {
		if !binding.ExpiresAt.After(in.Now) {
			continue
		}
		liveSessions++
		sessionsByID[binding.AuthID] = append(sessionsByID[binding.AuthID], binding)
	}

	overview := vpxyOverview{
		GeneratedAt:    in.Now,
		Routing:        vpxyRoutingFor(in.Config),
		Monitor:        vpxyMonitorFor(in.Config),
		Accounts:       []vpxyAccount{},
		AffinityBreaks: append([]quota.AffinityBreak{}, in.Breaks...),
	}
	overview.Routing.Sessions = liveSessions

	for _, a := range in.Auths {
		provider, ok := vpxyListedProvider(a)
		if !ok {
			continue
		}
		account := vpxyAccount{Account: quotaByID[a.ID], Label: vpxyLabel(a)}
		account.AuthID, account.Provider = a.ID, provider
		if priority, errPriority := strconv.Atoi(strings.TrimSpace(a.Attributes["priority"])); errPriority == nil {
			account.Priority = priority
		}
		if account.Windows == nil {
			account.Windows = []quota.Window{}
		}
		account.Status, account.StatusUntil = vpxyStatus(a, account.Account, in.Now)
		account.Sessions = vpxySessionsFor(sessionsByID[a.ID], in.Now)
		overview.Totals = addCacheCounters(overview.Totals, account.Cache)
		overview.Accounts = append(overview.Accounts, account)
	}
	sort.Slice(overview.Accounts, func(i, j int) bool {
		if overview.Accounts[i].Provider != overview.Accounts[j].Provider {
			return overview.Accounts[i].Provider < overview.Accounts[j].Provider
		}
		return overview.Accounts[i].AuthID < overview.Accounts[j].AuthID
	})
	return overview
}

// vpxyListedProvider returns the normalized provider of a Claude or Codex OAuth credential.
// API-key credentials have no subscription windows, so they are not listed.
func vpxyListedProvider(a *auth.Auth) (string, bool) {
	if a == nil {
		return "", false
	}
	provider := strings.ToLower(strings.TrimSpace(a.Provider))
	if provider != "claude" && provider != "codex" {
		return "", false
	}
	return provider, strings.TrimSpace(a.Attributes["api_key"]) == ""
}

func vpxyLabel(a *auth.Auth) string {
	if email, ok := a.Metadata["email"].(string); ok && strings.TrimSpace(email) != "" {
		return strings.TrimSpace(email)
	}
	if label := strings.TrimSpace(a.Label); label != "" {
		return label
	}
	return a.ID
}

// vpxyStatus reports whether the account can serve now and, if not, until when. A disabled
// credential never serves; a proxy cooldown is the router's own verdict, so it wins over an
// exhausted window read from the provider.
func vpxyStatus(a *auth.Auth, account quota.Account, now time.Time) (string, time.Time) {
	if a.Disabled || a.Status == auth.StatusDisabled {
		return vpxyStatusDisabled, time.Time{}
	}
	var cooldown time.Time
	if a.Quota.Exceeded && a.Quota.NextRecoverAt.After(now) {
		cooldown = a.Quota.NextRecoverAt
	}
	if a.Unavailable && a.NextRetryAfter.After(now) && a.NextRetryAfter.After(cooldown) {
		cooldown = a.NextRetryAfter
	}
	if !cooldown.IsZero() {
		return vpxyStatusCooldown, cooldown
	}
	if until, blocked := account.BlockedUntil(now); blocked {
		return vpxyStatusLimited, until
	}
	return vpxyStatusReady, time.Time{}
}

func vpxySessionsFor(bindings []auth.SessionBinding, now time.Time) vpxySessions {
	sort.Slice(bindings, func(i, j int) bool {
		if !bindings[i].ExpiresAt.Equal(bindings[j].ExpiresAt) {
			return bindings[i].ExpiresAt.After(bindings[j].ExpiresAt)
		}
		return bindings[i].SessionID < bindings[j].SessionID
	})
	sessions := vpxySessions{Count: len(bindings), Recent: []vpxySession{}}
	for _, binding := range bindings[:min(len(bindings), vpxyRecentSessions)] {
		sessions.Recent = append(sessions.Recent, vpxySession{
			ID:               vpxyShortSessionID(binding.SessionID),
			ExpiresInSeconds: int64(math.Ceil(binding.ExpiresAt.Sub(now).Seconds())),
		})
	}
	return sessions
}

// vpxyShortSessionID keeps enough of a session ID to tell sessions apart on screen.
func vpxyShortSessionID(id string) string {
	runes := []rune(id)
	if len(runes) <= vpxySessionIDChars {
		return id
	}
	return string(runes[:vpxySessionIDChars]) + "…"
}

func addCacheCounters(a, b quota.CacheCounters) quota.CacheCounters {
	return quota.CacheCounters{
		Requests:   a.Requests + b.Requests,
		Input:      a.Input + b.Input,
		Output:     a.Output + b.Output,
		CacheRead:  a.CacheRead + b.CacheRead,
		CacheWrite: a.CacheWrite + b.CacheWrite,
	}
}

// vpxyRoutingFor mirrors how sdk/cliproxy normalizes the routing block, so the dashboard shows
// the strategy the router actually runs.
func vpxyRoutingFor(cfg *config.Config) vpxyRouting {
	routing := vpxyRouting{Strategy: vpxyDefaultStrategy, SessionTTLSeconds: int64(vpxyDefaultTTL / time.Second), RebindOn: vpxyRebindOnAny}
	if cfg == nil {
		return routing
	}
	switch strings.ToLower(strings.TrimSpace(cfg.Routing.Strategy)) {
	case "weighted-round-robin", "weightedroundrobin", "wrr":
		routing.Strategy = vpxyStrategyWeighted
	case "fill-first", "fillfirst", "ff":
		routing.Strategy = vpxyStrategyFill
	case "expiration-first", "expirationfirst", "ef":
		routing.Strategy = vpxyStrategyExpiry
	}
	routing.SessionAffinity = cfg.Routing.SessionAffinity
	if raw := strings.TrimSpace(cfg.Routing.SessionAffinityTTL); raw != "" {
		if ttl, errParse := time.ParseDuration(raw); errParse == nil && ttl > 0 {
			routing.SessionTTLSeconds = max(int64(ttl/time.Second), 1)
		}
	}
	if routing.SessionAffinity && strings.EqualFold(strings.TrimSpace(cfg.Routing.SessionAffinityRebindOn), vpxyRebindOnQuota) {
		routing.RebindOn = vpxyRebindOnQuota
	}
	return routing
}

func vpxyMonitorFor(cfg *config.Config) vpxyMonitor {
	var monitorCfg config.QuotaMonitorConfig
	trusted := false
	if cfg != nil {
		monitorCfg = cfg.QuotaMonitor
		trusted = cfg.TrustedNetworks.Enabled
	}
	return vpxyMonitor{
		PollingEnabled:     !monitorCfg.Disabled,
		IntervalSeconds:    int64(monitorCfg.PollInterval() / time.Second),
		RebuildAlertTokens: monitorCfg.RebuildThreshold(),
		TrustedNetworks:    trusted,
	}
}

// vpxyRefreshGuard spaces out refreshes per target ("all" or an auth ID).
type vpxyRefreshGuard struct {
	mu   sync.Mutex
	now  func() time.Time
	last map[string]time.Time
}

func newVPXYRefreshGuard(now func() time.Time) *vpxyRefreshGuard {
	return &vpxyRefreshGuard{now: now, last: make(map[string]time.Time)}
}

// allow records a refresh of target and reports true, or reports how long to wait.
func (g *vpxyRefreshGuard) allow(target string) (time.Duration, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	if last, seen := g.last[target]; seen {
		if wait := last.Add(vpxyMinRefreshSpacing).Sub(now); wait > 0 {
			return wait, false
		}
	}
	g.last[target] = now
	return 0, true
}

func (s *Server) registerVPXYRoutes() {
	group := s.engine.Group("/vpxy/api", s.vpxyAccessMiddleware())
	group.GET("/overview", s.vpxyOverviewHandler)
	group.POST("/quota/refresh", s.vpxyRefreshHandler)
}

// vpxyAccessMiddleware admits requests from a trusted network (which already refuses cross-site
// pages and rebound host names) or carrying the management key.
func (s *Server) vpxyAccessMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if cfg := s.getConfig(); cfg != nil && configaccess.TrustedRequest(&cfg.SDKConfig, c.Request) {
			c.Next()
			return
		}
		provided := strings.TrimSpace(c.GetHeader("X-Management-Key"))
		if header := c.GetHeader("Authorization"); provided == "" && header != "" {
			provided = strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
		}
		if provided == "" || s.mgmt == nil {
			// Never counted as a failed attempt: the dashboard probes without a key first.
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "management key required"})
			return
		}
		clientIP := c.ClientIP()
		allowed, status, message := s.mgmt.AuthenticateManagementKey(clientIP, clientIP == "127.0.0.1" || clientIP == "::1", provided)
		if !allowed {
			c.AbortWithStatusJSON(status, gin.H{"error": message})
			return
		}
		c.Next()
	}
}

// vpxyManagementAvailabilityMiddleware permits trusted-only v8 management without enabling v0.
func (s *Server) vpxyManagementAvailabilityMiddleware() gin.HandlerFunc {
	keyed := s.managementAvailabilityMiddleware()
	return func(c *gin.Context) {
		if cfg := s.getConfig(); cfg != nil && !cfg.Home.Enabled && configaccess.TrustedRequest(&cfg.SDKConfig, c.Request) {
			c.Next()
			return
		}
		keyed(c)
	}
}

// vpxyManagementMiddleware guards the v8 management API. Requests from a trusted network (this
// machine and the tailnet, already screened for cross-site pages and rebound host names) need no
// management key, so the dashboard can manage the proxy passwordless; every other request goes
// through the upstream key check, including its remote-management switch.
func (s *Server) vpxyManagementMiddleware() gin.HandlerFunc {
	keyed := s.mgmt.Middleware()
	return func(c *gin.Context) {
		if cfg := s.getConfig(); cfg != nil && configaccess.TrustedRequest(&cfg.SDKConfig, c.Request) {
			management.WriteServerHeaders(c)
			c.Next()
			return
		}
		keyed(c)
	}
}

func (s *Server) vpxyOverviewHandler(c *gin.Context) {
	c.JSON(http.StatusOK, s.vpxyOverview())
}

func (s *Server) vpxyOverview() vpxyOverview {
	in := vpxyOverviewInput{Now: time.Now(), Config: s.getConfig()}
	if manager := s.handlers.AuthManager; manager != nil {
		in.Auths = manager.List()
		if source, ok := manager.Selector().(interface{ Bindings() []auth.SessionBinding }); ok {
			in.Bindings = source.Bindings()
		}
	}
	if s.quotaStore != nil {
		in.Accounts = s.quotaStore.Snapshot()
		in.Breaks = s.quotaStore.AffinityBreaks()
	}
	return buildVPXYOverview(in)
}

// vpxyRefreshHandler polls the upstream usage endpoint of one account ({"auth_id": "..."}) or of
// every account (empty body) and answers with the fresh overview. A failed poll is reported on
// the account as poll_error rather than as an HTTP error.
func (s *Server) vpxyRefreshHandler(c *gin.Context) {
	if s.quotaPoller == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "quota monitor is not running"})
		return
	}
	var body struct {
		AuthID string `json:"auth_id"`
	}
	raw, errRead := io.ReadAll(io.LimitReader(c.Request.Body, vpxyMaxRefreshBody))
	if errRead != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "reading request body failed"})
		return
	}
	if len(strings.TrimSpace(string(raw))) > 0 {
		if errDecode := json.Unmarshal(raw, &body); errDecode != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
	}
	target := strings.TrimSpace(body.AuthID)
	if target != "" && !s.vpxyListsAccount(target) {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown account"})
		return
	}
	key := target
	if key == "" {
		key = vpxyRefreshAll
	}
	if wait, ok := s.vpxyRefresh.allow(key); !ok {
		c.Header("Retry-After", strconv.FormatInt(int64(math.Ceil(wait.Seconds())), 10))
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "refreshed too recently"})
		return
	}
	ctx := c.Request.Context()
	if target == "" {
		s.quotaPoller.RefreshAll(ctx)
	} else if errRefresh := s.quotaPoller.Refresh(ctx, target); errRefresh != nil && !errors.Is(errRefresh, ctx.Err()) {
		log.WithError(errRefresh).WithField("auth_id", target).Debug("dashboard quota refresh failed")
	}
	c.JSON(http.StatusOK, s.vpxyOverview())
}

func (s *Server) vpxyListsAccount(authID string) bool {
	manager := s.handlers.AuthManager
	if manager == nil {
		return false
	}
	a, ok := manager.GetByID(authID)
	if !ok {
		return false
	}
	_, listed := vpxyListedProvider(a)
	return listed
}
