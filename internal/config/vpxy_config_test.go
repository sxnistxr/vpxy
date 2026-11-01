package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func TestTrustedNetworksParsedPrefixes(t *testing.T) {
	prefixes, err := TrustedNetworksConfig{}.ParsedPrefixes()
	if err != nil {
		t.Fatalf("defaults: %v", err)
	}
	if len(prefixes) != len(DefaultTrustedNetworkCIDRs) {
		t.Fatalf("defaults parsed %d prefixes, want %d", len(prefixes), len(DefaultTrustedNetworkCIDRs))
	}

	prefixes, err = TrustedNetworksConfig{CIDRs: []string{" 10.0.0.9/8 ", "", "::ffff:192.0.2.1"}}.ParsedPrefixes()
	if err != nil {
		t.Fatalf("custom: %v", err)
	}
	if len(prefixes) != 2 || prefixes[0].String() != "10.0.0.0/8" || prefixes[1].String() != "192.0.2.1/32" {
		t.Fatalf("custom prefixes = %v", prefixes)
	}

	if _, err = (TrustedNetworksConfig{CIDRs: []string{"10.0.0.0/33"}}).ParsedPrefixes(); err == nil {
		t.Fatalf("expected error for invalid CIDR")
	}
}

func TestQuotaMonitorDefaults(t *testing.T) {
	cases := map[string]time.Duration{
		"":     5 * time.Minute,
		"bad":  5 * time.Minute,
		"-1m":  5 * time.Minute,
		"10s":  time.Minute,
		"90s":  90 * time.Second,
		"15m ": 15 * time.Minute,
	}
	for raw, want := range cases {
		if got := (QuotaMonitorConfig{Interval: raw}).PollInterval(); got != want {
			t.Fatalf("PollInterval(%q) = %s, want %s", raw, got, want)
		}
	}
	if got := (QuotaMonitorConfig{}).RebuildThreshold(); got != 100000 {
		t.Fatalf("default RebuildThreshold = %d", got)
	}
	if got := (QuotaMonitorConfig{RebuildAlertTokens: 5000}).RebuildThreshold(); got != 5000 {
		t.Fatalf("RebuildThreshold = %d", got)
	}
}

func TestCodexOAuthWebsocketsEnabled(t *testing.T) {
	off := false
	on := true
	var nilCfg *CodexConfig
	if !nilCfg.OAuthWebsocketsEnabled() || !(&CodexConfig{}).OAuthWebsocketsEnabled() {
		t.Fatalf("unset must default to enabled")
	}
	if (&CodexConfig{OAuthWebsockets: &off}).OAuthWebsocketsEnabled() {
		t.Fatalf("explicit false must disable")
	}
	if !(&CodexConfig{OAuthWebsockets: &on}).OAuthWebsocketsEnabled() {
		t.Fatalf("explicit true must enable")
	}
}

func TestVPXYKeysLoadFromTheV8Layout(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	body := `config-version: 8
server:
  port: 8317
trusted-networks:
  enabled: true
  allowed-hosts: ["vpxy.example.com"]
quota-monitor:
  interval: 2m
  rebuild-alert-tokens: 250000
oauth:
  providers:
    codex:
      oauth-websockets: false
routing:
  strategy: expiration-first
  session-affinity: true
  session-affinity-ttl: 15m
  session-affinity-rebind-on: quota
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.TrustedNetworks.Enabled || len(cfg.TrustedNetworks.AllowedHosts) != 1 {
		t.Fatalf("trusted-networks = %+v", cfg.TrustedNetworks)
	}
	if cfg.QuotaMonitor.PollInterval() != 2*time.Minute || cfg.QuotaMonitor.RebuildThreshold() != 250000 {
		t.Fatalf("quota-monitor = %+v", cfg.QuotaMonitor)
	}
	if cfg.Codex.OAuthWebsocketsEnabled() {
		t.Fatal("oauth.providers.codex.oauth-websockets: false was not applied")
	}
	if cfg.Routing.Strategy != "expiration-first" || !cfg.Routing.SessionAffinity || cfg.Routing.SessionAffinityTTL != "15m" || cfg.Routing.SessionAffinityRebindOn != "quota" {
		t.Fatalf("routing = %+v", cfg.Routing)
	}
}

// A v8 configuration write (dashboard or management API) migrates the file and comments out
// sections it does not know; the VPXY sections must stay active, or one routing save would
// switch off passwordless access and the quota monitor.
func TestVPXYSectionsSurviveV8Writes(t *testing.T) {
	raw := []byte(`config-version: 8
server:
  port: 8317
# Passwordless access for this machine and the tailnet.
trusted-networks:
  enabled: true
  allowed-hosts: ["vpxy.example.com"]
quota-monitor:
  interval: 2m
  rebuild-alert-tokens: 250000
  forgotten-knob: 1
routing:
  strategy: expiration-first
`)
	migrated, _, err := NormalizeConfigLayout(raw, true)
	if err != nil {
		t.Fatal(err)
	}
	text := string(migrated)
	for _, gone := range []string{"# trusted-networks:", "# quota-monitor:"} {
		if strings.Contains(text, gone) {
			t.Fatalf("v8 write commented out a VPXY section (%s):\n%s", gone, text)
		}
	}
	if !strings.Contains(text, "# Passwordless access for this machine and the tailnet.") {
		t.Fatalf("v8 write dropped the trusted-networks comment:\n%s", text)
	}
	if !strings.Contains(text, "# quota-monitor.forgotten-knob: 1") {
		t.Fatalf("unknown nested field under quota-monitor was not commented out:\n%s", text)
	}
	if err = ValidateV8Config(migrated); err != nil {
		t.Fatalf("v8 validation rejects the VPXY sections: %v", err)
	}
	cfg, err := ParseConfigBytes(migrated)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.TrustedNetworks.Enabled || len(cfg.TrustedNetworks.AllowedHosts) != 1 || cfg.QuotaMonitor.PollInterval() != 2*time.Minute {
		t.Fatalf("effective VPXY settings changed: trusted=%+v monitor=%+v", cfg.TrustedNetworks, cfg.QuotaMonitor)
	}
}

// The VPXY sections exist in both layouts, so on their own they must not mark a legacy
// file as v8 (that would skip its migration).
func TestVPXYSectionsDoNotMarkALegacyFileAsV8(t *testing.T) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte("port: 8317\ntrusted-networks:\n  enabled: true\nquota-monitor:\n  interval: 5m\n"), &doc); err != nil {
		t.Fatal(err)
	}
	if IsV8ConfigLayout(doc.Content[0]) {
		t.Fatal("a legacy file with only VPXY sections was detected as v8")
	}
}
