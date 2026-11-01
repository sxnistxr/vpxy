package config

import (
	"fmt"
	"net/netip"
	"strings"
	"time"
)

// DefaultTrustedNetworkCIDRs covers loopback plus the address ranges Tailscale assigns to
// tailnet devices (the 100.64.0.0/10 CGNAT range and the fd7a:115c:a1e0::/48 ULA range).
var DefaultTrustedNetworkCIDRs = []string{
	"127.0.0.0/8",
	"::1/128",
	"100.64.0.0/10",
	"fd7a:115c:a1e0::/48",
}

// TrustedNetworksConfig lets requests from trusted networks use the proxy without an API key.
// Requests from any other network still need one of the configured api-keys; when no api-keys
// are configured those requests are rejected.
type TrustedNetworksConfig struct {
	// Enabled turns on passwordless access for the trusted CIDRs.
	Enabled bool `yaml:"enabled" json:"enabled"`
	// CIDRs lists the trusted networks. Empty uses DefaultTrustedNetworkCIDRs.
	CIDRs []string `yaml:"cidrs,omitempty" json:"cidrs,omitempty"`
	// AllowedHosts adds Host header names (exact, or "*.example.com") that may reach the proxy
	// without a key. IP addresses, localhost, single-label names, *.local and *.ts.net are always
	// allowed; any other name is refused so a web page cannot rebind its DNS to a trusted address.
	AllowedHosts []string `yaml:"allowed-hosts,omitempty" json:"allowed-hosts,omitempty"`
}

// EffectiveCIDRs returns the configured CIDRs, or the defaults when none are set.
func (c TrustedNetworksConfig) EffectiveCIDRs() []string {
	if len(c.CIDRs) == 0 {
		return append([]string(nil), DefaultTrustedNetworkCIDRs...)
	}
	return append([]string(nil), c.CIDRs...)
}

// ParsedPrefixes parses EffectiveCIDRs. Bare addresses are accepted as single-host prefixes.
func (c TrustedNetworksConfig) ParsedPrefixes() ([]netip.Prefix, error) {
	cidrs := c.EffectiveCIDRs()
	prefixes := make([]netip.Prefix, 0, len(cidrs))
	for _, raw := range cidrs {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		if !strings.Contains(value, "/") {
			addr, errAddr := netip.ParseAddr(value)
			if errAddr != nil {
				return nil, fmt.Errorf("trusted-networks: invalid address %q: %w", value, errAddr)
			}
			prefixes = append(prefixes, netip.PrefixFrom(addr.Unmap(), addr.Unmap().BitLen()))
			continue
		}
		prefix, errPrefix := netip.ParsePrefix(value)
		if errPrefix != nil {
			return nil, fmt.Errorf("trusted-networks: invalid CIDR %q: %w", value, errPrefix)
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

// QuotaMonitorConfig configures the background poller that reads subscription usage windows
// (5-hour, 7-day, model-scoped weekly limits and banked resets) from the Claude and Codex
// OAuth usage endpoints.
type QuotaMonitorConfig struct {
	// Disabled turns the background poller off. Response headers are still observed.
	Disabled bool `yaml:"disabled" json:"disabled"`
	// Interval between polls of each credential. Default 5m, minimum 1m.
	Interval string `yaml:"interval,omitempty" json:"interval,omitempty"`
	// RebuildAlertTokens flags a request whose cache write tokens reach this size as a
	// prompt-cache rebuild on the dashboard. Default 100000.
	RebuildAlertTokens int64 `yaml:"rebuild-alert-tokens,omitempty" json:"rebuild-alert-tokens,omitempty"`
}

const (
	defaultQuotaMonitorInterval       = 5 * time.Minute
	minQuotaMonitorInterval           = time.Minute
	defaultQuotaRebuildAlertThreshold = int64(100000)
)

// PollInterval returns the effective poll interval.
func (c QuotaMonitorConfig) PollInterval() time.Duration {
	raw := strings.TrimSpace(c.Interval)
	if raw == "" {
		return defaultQuotaMonitorInterval
	}
	parsed, errParse := time.ParseDuration(raw)
	if errParse != nil || parsed <= 0 {
		return defaultQuotaMonitorInterval
	}
	if parsed < minQuotaMonitorInterval {
		return minQuotaMonitorInterval
	}
	return parsed
}

// RebuildThreshold returns the effective cache-rebuild alert threshold.
func (c QuotaMonitorConfig) RebuildThreshold() int64 {
	if c.RebuildAlertTokens <= 0 {
		return defaultQuotaRebuildAlertThreshold
	}
	return c.RebuildAlertTokens
}

// OAuthWebsocketsEnabled reports whether Codex OAuth credentials default to the upstream
// WebSocket transport for downstream WebSocket clients. Unset means enabled. A credential
// can still opt out with "websockets": false in its auth file.
func (c *CodexConfig) OAuthWebsocketsEnabled() bool {
	return c == nil || c.OAuthWebsockets == nil || *c.OAuthWebsockets
}

// vpxySharedRoots are the VPXY top-level config sections. They sit at the same path in the legacy
// and v8 layouts, so v8 writes keep them (instead of commenting them out as unknown) and they do
// not on their own mark a file as v8.
var vpxySharedRoots = []string{"trusted-networks", "quota-monitor"}
