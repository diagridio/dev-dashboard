package discovery

import "strconv"
import "strings"

type ParsedArgs struct {
	AppID         string
	HTTPPort      int
	GRPCPort      int
	AppPort       int
	ConfigPath    string
	ResourcePaths []string
}

// ParseDaprdArgs extracts the fields we surface from a daprd process's argv.
func ParseDaprdArgs(args []string) ParsedArgs {
	var p ParsedArgs
	for i := 0; i < len(args); i++ {
		flag, val, hasEq := strings.Cut(args[i], "=")
		next := func() string {
			if hasEq {
				return val
			}
			if i+1 < len(args) {
				i++
				return args[i]
			}
			return ""
		}
		switch flag {
		case "--app-id":
			p.AppID = next()
		case "--dapr-http-port":
			p.HTTPPort, _ = strconv.Atoi(next())
		case "--dapr-grpc-port":
			p.GRPCPort, _ = strconv.Atoi(next())
		case "--app-port":
			p.AppPort, _ = strconv.Atoi(next())
		case "--config":
			p.ConfigPath = next()
		case "--resources-path", "--components-path":
			if v := next(); v != "" {
				p.ResourcePaths = append(p.ResourcePaths, v)
			}
		}
	}
	return p
}
