package configaccess

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	sdkaccess "github.com/router-for-me/CLIProxyAPI/v8/sdk/access"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	log "github.com/sirupsen/logrus"
)

const (
	// AccessProviderTypeTrustedNetwork admits requests whose TCP peer is in a trusted CIDR.
	AccessProviderTypeTrustedNetwork = "trusted-network"
	// TrustedNetworkPrincipal is the principal recorded for requests admitted by network.
	TrustedNetworkPrincipal = "trusted-network"
)

// registerTrustedNetworks registers or removes the trusted-network provider.
func registerTrustedNetworks(cfg *sdkconfig.SDKConfig) {
	if cfg == nil || !cfg.TrustedNetworks.Enabled {
		sdkaccess.UnregisterProvider(AccessProviderTypeTrustedNetwork)
		return
	}
	provider, errProvider := newTrustedNetworkProvider(cfg.TrustedNetworks)
	if errProvider != nil {
		// A broken list must never widen access, so the provider is removed.
		log.WithError(errProvider).Error("trusted-networks disabled: invalid CIDR list")
		sdkaccess.UnregisterProvider(AccessProviderTypeTrustedNetwork)
		return
	}
	if len(provider.prefixes) == 0 {
		sdkaccess.UnregisterProvider(AccessProviderTypeTrustedNetwork)
		return
	}
	sdkaccess.RegisterProvider(AccessProviderTypeTrustedNetwork, provider)
}

type trustedNetworkProvider struct {
	prefixes     []netip.Prefix
	allowedHosts []string // lower-case exact names or "*.suffix" patterns
}

func newTrustedNetworkProvider(cfg config.TrustedNetworksConfig) (*trustedNetworkProvider, error) {
	prefixes, errParse := cfg.ParsedPrefixes()
	if errParse != nil {
		return nil, errParse
	}
	hosts := make([]string, 0, len(cfg.AllowedHosts))
	for _, host := range cfg.AllowedHosts {
		if host = strings.ToLower(strings.TrimSpace(host)); host != "" {
			hosts = append(hosts, host)
		}
	}
	return &trustedNetworkProvider{prefixes: prefixes, allowedHosts: hosts}, nil
}

func (p *trustedNetworkProvider) Identifier() string {
	return AccessProviderTypeTrustedNetwork
}

// Authenticate admits the request when its TCP peer address is trusted and it does not look like
// a web page attacking a local service. Forwarding headers are ignored on purpose: they are
// client-controlled. Any Authorization or x-api-key header the client sends (for example Claude
// Code's own OAuth token) is left for the handlers to discard, so a local client never fails on
// a key the proxy does not know.
func (p *trustedNetworkProvider) Authenticate(_ context.Context, r *http.Request) (*sdkaccess.Result, *sdkaccess.AuthError) {
	if p == nil || r == nil {
		return nil, sdkaccess.NewNotHandledError()
	}
	addr, ok := p.admits(r)
	if !ok {
		return nil, sdkaccess.NewNotHandledError()
	}
	return &sdkaccess.Result{
		Provider:  AccessProviderTypeTrustedNetwork,
		Principal: TrustedNetworkPrincipal,
		Metadata: map[string]string{
			"source":    "trusted-network",
			"remote_ip": addr.String(),
		},
	}, nil
}

// admits reports whether r may skip the API key, returning its peer address. A browser can be
// steered at a local service in two ways: a cross-site page sends requests carrying its own
// Origin, and a page that re-points its DNS name at 127.0.0.1 ("DNS rebinding") reaches the
// service with a public Host name. Neither is a user at the keyboard, so both must present a key.
func (p *trustedNetworkProvider) admits(r *http.Request) (netip.Addr, bool) {
	addr, ok := RemoteAddr(r)
	if !ok || !p.contains(addr) || !p.hostAllowed(r.Host) || !sameOrigin(r) {
		return netip.Addr{}, false
	}
	return addr, true
}

// hostAllowed reports whether a Host header names this machine rather than a public domain:
// an IP address, localhost, a single-label name (such as a Tailscale short name), *.local or
// *.ts.net, or one of the configured allowed-hosts.
func (p *trustedNetworkProvider) hostAllowed(hostHeader string) bool {
	name := strings.ToLower(strings.TrimSpace(hostHeader))
	if host, _, errSplit := net.SplitHostPort(name); errSplit == nil {
		name = host
	}
	name = strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(name, "["), "]"), ".")
	if name == "" {
		return false
	}
	if _, errAddr := netip.ParseAddr(name); errAddr == nil || !strings.Contains(name, ".") {
		return true
	}
	for _, suffix := range []string{".localhost", ".local", ".ts.net"} {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	for _, pattern := range p.allowedHosts {
		if suffix, wildcard := strings.CutPrefix(pattern, "*"); wildcard {
			if strings.HasSuffix(name, suffix) && len(name) > len(suffix) {
				return true
			}
		} else if name == pattern {
			return true
		}
	}
	return false
}

// sameOrigin reports whether r carries no Origin header (CLIs and curl send none) or one that
// matches its own Host, as the dashboard calling its own server does. A no-cors request from
// another site (an <img>, a <script>, a link) has no Origin, so the browser's Sec-Fetch-Site
// label must also say the request came from this origin or from the address bar.
func sameOrigin(r *http.Request) bool {
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))) {
	case "", "same-origin", "none":
	default:
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, errParse := url.Parse(origin)
	return errParse == nil && parsed.Host != "" && strings.EqualFold(parsed.Host, r.Host)
}

func (p *trustedNetworkProvider) contains(addr netip.Addr) bool {
	for _, prefix := range p.prefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// RemoteAddr returns the TCP peer address of r with IPv4-mapped IPv6 addresses unmapped and
// IPv6 zones dropped (netip.Prefix.Contains never matches a zoned address).
func RemoteAddr(r *http.Request) (netip.Addr, bool) {
	if r == nil {
		return netip.Addr{}, false
	}
	raw := strings.TrimSpace(r.RemoteAddr)
	if raw == "" {
		return netip.Addr{}, false
	}
	if addrPort, errParse := netip.ParseAddrPort(raw); errParse == nil {
		return addrPort.Addr().Unmap().WithZone(""), true
	}
	host := raw
	if h, _, errSplit := net.SplitHostPort(raw); errSplit == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if zone := strings.IndexByte(host, '%'); zone >= 0 {
		host = host[:zone]
	}
	addr, errAddr := netip.ParseAddr(host)
	if errAddr != nil {
		return netip.Addr{}, false
	}
	return addr.Unmap(), true
}

// TrustedRequest reports whether r comes from a trusted network under cfg.
func TrustedRequest(cfg *sdkconfig.SDKConfig, r *http.Request) bool {
	if cfg == nil || !cfg.TrustedNetworks.Enabled {
		return false
	}
	provider, errProvider := newTrustedNetworkProvider(cfg.TrustedNetworks)
	if errProvider != nil {
		return false
	}
	_, admitted := provider.admits(r)
	return admitted
}
