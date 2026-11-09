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
	flags := parseFlags(argv[start+1:])
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

// parseFlags collects daprd-style flags from args into name -> value. It
// accepts -flag value, --flag value, -flag=value and --flag=value; tokens that
// are not flags are skipped, and a following token that starts with "-" is
// never taken as a value (the flag is then a boolean and is not recorded).
func parseFlags(args []string) map[string]string {
	flags := map[string]string{}
	for i := 0; i < len(args); i++ {
		tok := args[i]
		if !strings.HasPrefix(tok, "-") {
			continue
		}
		name := strings.TrimLeft(tok, "-")
		if eq := strings.IndexByte(name, '='); eq >= 0 {
			flags[name[:eq]] = name[eq+1:]
			continue
		}
		if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
			flags[name] = args[i+1]
			i++
		}
	}
	return flags
}
