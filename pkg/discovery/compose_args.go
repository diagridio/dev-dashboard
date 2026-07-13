package discovery

import (
	"path"
	"strconv"
	"strings"
)

// daprdArgs is the subset of daprd flags the compose scanner consumes.
type daprdArgs struct {
	AppID             string
	AppChannelAddress string
	ResourcesPath     string
	ConfigPath        string
	AppProtocol       string
	AppPort           int
	HTTPPort          int // container-internal; defaults to 3500 like daprd itself
	GRPCPort          int // container-internal; defaults to 50001 like daprd itself
}

// parseDaprdArgs extracts daprd flags from a container's argv (entrypoint+cmd).
// ok is false when argv does not invoke daprd (no token whose basename is
// "daprd"). Accepts -flag value, --flag value, and -flag=value forms.
func parseDaprdArgs(argv []string) (daprdArgs, bool) {
	start := -1
	for i, tok := range argv {
		if path.Base(tok) == "daprd" {
			start = i
			break
		}
	}
	if start == -1 {
		return daprdArgs{}, false
	}
	flags := map[string]string{}
	rest := argv[start+1:]
	for i := 0; i < len(rest); i++ {
		tok := rest[i]
		if !strings.HasPrefix(tok, "-") {
			continue
		}
		name := strings.TrimLeft(tok, "-")
		if eq := strings.IndexByte(name, '='); eq >= 0 {
			flags[name[:eq]] = name[eq+1:]
			continue
		}
		if i+1 < len(rest) && !strings.HasPrefix(rest[i+1], "-") {
			flags[name] = rest[i+1]
			i++
		}
	}
	atoi := func(s string) int { n, _ := strconv.Atoi(s); return n }
	d := daprdArgs{
		AppID:             flags["app-id"],
		AppChannelAddress: flags["app-channel-address"],
		ResourcesPath:     flags["resources-path"],
		ConfigPath:        flags["config"],
		AppProtocol:       flags["app-protocol"],
		AppPort:           atoi(flags["app-port"]),
		HTTPPort:          atoi(flags["dapr-http-port"]),
		GRPCPort:          atoi(flags["dapr-grpc-port"]),
	}
	if d.ResourcesPath == "" {
		d.ResourcesPath = flags["components-path"] // legacy daprd flag
	}
	if d.HTTPPort == 0 {
		d.HTTPPort = 3500
	}
	if d.GRPCPort == 0 {
		d.GRPCPort = 50001
	}
	return d, true
}
