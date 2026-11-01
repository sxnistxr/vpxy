package quota

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	log "github.com/sirupsen/logrus"
)

const (
	defaultPollInterval  = 5 * time.Minute
	defaultPollTimeout   = 30 * time.Second
	maxConcurrentPolls   = 4
	maxPollBodyBytes     = 1 << 20
	defaultClaudeBaseURL = "https://api.anthropic.com"
	defaultCodexBaseURL  = "https://chatgpt.com"
	claudeUsagePath      = "/api/oauth/usage"
	claudeBankedQuery    = "?cedar_ember=1&skip_spend=1"
	codexUsagePath       = "/backend-api/wham/usage"
	claudeOAuthBeta      = "oauth-2025-04-20"
	claudeUserAgent      = "claude-cli/2.1.280 (external, cli)"
	codexUserAgent       = "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)"
)

// Credential is what the poller needs to query a provider's usage endpoint for one account.
type Credential struct {
	AuthID    string
	Provider  string // "claude" or "codex"
	Token     string
	AccountID string // ChatGPT account id, sent for Codex only
	ProxyURL  string
}

// CredentialSource lists the accounts to poll. It is read on every pass, so tokens stay fresh.
type CredentialSource interface {
	Credentials() []Credential
}

// PollerConfig configures a Poller. Zero values select the defaults.
type PollerConfig struct {
	Store         *Store
	Source        CredentialSource
	Client        func(proxyURL string) *http.Client
	Interval      time.Duration
	Timeout       time.Duration
	ClaudeBaseURL string
	CodexBaseURL  string
	Now           func() time.Time
}

// Poller reads each account's usage endpoint on an interval and records the result in a Store.
type Poller struct {
	store      *Store
	source     CredentialSource
	client     func(proxyURL string) *http.Client
	interval   time.Duration
	timeout    time.Duration
	claudeBase string
	codexBase  string
	now        func() time.Time
	newTicker  func(time.Duration) (<-chan time.Time, func())
}

// NewPoller returns a Poller for cfg.
func NewPoller(cfg PollerConfig) *Poller {
	p := &Poller{
		store:      cfg.Store,
		source:     cfg.Source,
		client:     cfg.Client,
		interval:   cfg.Interval,
		timeout:    cfg.Timeout,
		claudeBase: strings.TrimRight(cfg.ClaudeBaseURL, "/"),
		codexBase:  strings.TrimRight(cfg.CodexBaseURL, "/"),
		now:        cfg.Now,
		newTicker: func(d time.Duration) (<-chan time.Time, func()) {
			ticker := time.NewTicker(d)
			return ticker.C, ticker.Stop
		},
	}
	if p.client == nil {
		p.client = func(string) *http.Client { return http.DefaultClient }
	}
	if p.interval <= 0 {
		p.interval = defaultPollInterval
	}
	if p.timeout <= 0 {
		p.timeout = defaultPollTimeout
	}
	if p.claudeBase == "" {
		p.claudeBase = defaultClaudeBaseURL
	}
	if p.codexBase == "" {
		p.codexBase = defaultCodexBaseURL
	}
	if p.now == nil {
		p.now = time.Now
	}
	return p
}

// Run polls every account at once and then on every interval until ctx ends.
func (p *Poller) Run(ctx context.Context) {
	ticks, stop := p.newTicker(p.interval)
	defer stop()
	for {
		p.RefreshAll(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticks:
		}
	}
}

// RefreshAll polls every supported account once, a few at a time, and records each outcome.
func (p *Poller) RefreshAll(ctx context.Context) {
	var wg sync.WaitGroup
	slots := make(chan struct{}, maxConcurrentPolls)
	for _, cred := range p.source.Credentials() {
		if !pollable(cred) {
			continue
		}
		// Checked explicitly: a select would pick at random when a slot and Done are both ready.
		if ctx.Err() != nil {
			break
		}
		slots <- struct{}{}
		wg.Go(func() {
			defer func() { <-slots }()
			if err := p.refresh(ctx, cred); err != nil {
				log.WithError(err).WithFields(log.Fields{"auth_id": cred.AuthID, "provider": cred.Provider}).Debug("quota poll failed")
			}
		})
	}
	wg.Wait()
}

// Refresh polls one account on demand.
func (p *Poller) Refresh(ctx context.Context, authID string) error {
	for _, cred := range p.source.Credentials() {
		if cred.AuthID == authID && pollable(cred) {
			return p.refresh(ctx, cred)
		}
	}
	return fmt.Errorf("no pollable credential for %q", authID)
}

func pollable(c Credential) bool {
	return c.AuthID != "" && c.Token != "" && supportsQuota(strings.ToLower(strings.TrimSpace(c.Provider)))
}

// refresh polls one account and records the outcome. The timeout bounds this background
// request only; it never applies to proxied client traffic.
func (p *Poller) refresh(parent context.Context, cred Credential) error {
	ctx, cancel := context.WithTimeout(parent, p.timeout)
	defer cancel()

	provider := strings.ToLower(strings.TrimSpace(cred.Provider))
	client := p.client(cred.ProxyURL)
	var (
		obs Observation
		err error
	)
	if provider == "claude" {
		obs, err = p.pollClaude(ctx, client, cred)
	} else {
		obs, err = p.pollCodex(ctx, client, cred)
	}
	if parent.Err() != nil {
		// Shutting down: drop the result instead of recording a spurious "context canceled".
		return err
	}
	at := p.now()
	if err == nil {
		p.store.Observe(cred.AuthID, provider, obs, at, SourcePoll)
	}
	p.store.NotePoll(cred.AuthID, provider, at, err)
	return err
}

func (p *Poller) pollClaude(ctx context.Context, client *http.Client, cred Credential) (Observation, error) {
	header := http.Header{}
	header.Set("Authorization", "Bearer "+cred.Token)
	header.Set("Anthropic-Beta", claudeOAuthBeta)
	header.Set("User-Agent", claudeUserAgent)
	header.Set("Accept", "application/json")

	body, err := fetch(ctx, client, p.claudeBase+claudeUsagePath, header)
	if err != nil {
		return Observation{}, err
	}
	obs, err := ParseClaudeUsage(body, p.now())
	if err != nil {
		return Observation{}, err
	}
	// Banked resets come from a second read. Missing them must not hide the windows.
	if bankedBody, errBanked := fetch(ctx, client, p.claudeBase+claudeUsagePath+claudeBankedQuery, header); errBanked != nil {
		log.WithError(errBanked).WithField("auth_id", cred.AuthID).Debug("claude banked reset read failed")
	} else if banked, errParse := ParseClaudeBanked(bankedBody); errParse != nil {
		log.WithError(errParse).WithField("auth_id", cred.AuthID).Debug("claude banked reset parse failed")
	} else {
		obs.Banked = banked
	}
	return obs, nil
}

func (p *Poller) pollCodex(ctx context.Context, client *http.Client, cred Credential) (Observation, error) {
	header := http.Header{}
	header.Set("Authorization", "Bearer "+cred.Token)
	header.Set("User-Agent", codexUserAgent)
	header.Set("Accept", "application/json")
	if cred.AccountID != "" {
		header.Set("Chatgpt-Account-Id", cred.AccountID)
	}
	body, err := fetch(ctx, client, p.codexBase+codexUsagePath, header)
	if err != nil {
		return Observation{}, err
	}
	return ParseCodexUsage(body, p.now())
}

// fetch GETs url and returns the body of a 2xx response. Error text never includes the body,
// which can echo account details.
func fetch(ctx context.Context, client *http.Client, url string, header http.Header) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("building usage request: %w", err)
	}
	req.Header = header.Clone()
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("requesting usage: %w", err)
	}
	defer func() {
		if errClose := resp.Body.Close(); errClose != nil {
			log.WithError(errClose).Debug("closing usage response body")
		}
	}()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("usage endpoint returned status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxPollBodyBytes))
	if err != nil {
		return nil, fmt.Errorf("reading usage response: %w", err)
	}
	if len(body) == 0 {
		return nil, errors.New("usage endpoint returned an empty body")
	}
	return body, nil
}
