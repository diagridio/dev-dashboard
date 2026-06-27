package discovery

// Health represents the health status of an instance
type Health string

const (
	HealthHealthy   Health = "healthy"
	HealthStarting  Health = "starting"
	HealthUnhealthy Health = "unhealthy"
	HealthUnknown   Health = "unknown"
)

// Instance represents a running application instance with Dapr
type Instance struct {
	AppID           string         `json:"appId"`
	Health          Health         `json:"health"`
	Runtime         string         `json:"runtime"` // e.g. "go", "python", "node", "dotnet", "java", "unknown"
	HTTPPort        int            `json:"httpPort"`
	GRPCPort        int            `json:"grpcPort"`
	AppPort         int            `json:"appPort"`
	DaprdPID        int            `json:"daprdPid"`
	AppPID          int            `json:"appPid"` // 0 = unknown
	CLIPID          int            `json:"cliPid"`
	Age             string         `json:"age"`     // human, e.g. "14m"
	Created         string         `json:"created"` // local time string
	RunTemplate     string         `json:"runTemplate"`
	ResourcePaths   []string       `json:"resourcePaths"`
	ConfigPath      string         `json:"configPath"`
	AppLogPath      string         `json:"appLogPath"`
	DaprdLogPath    string         `json:"daprdLogPath"`
	Command         string         `json:"command"`
	RuntimeVersion  string         `json:"runtimeVersion"` // from metadata; "" if unavailable
	MetadataOK      bool           `json:"metadataOk"`     // false if /v1.0/metadata failed
	Actors          []ActorType    `json:"actors,omitempty"`
	Subscriptions   []Subscription `json:"subscriptions,omitempty"`
	Components      []Component    `json:"components,omitempty"`
	EnabledFeatures []string       `json:"enabledFeatures,omitempty"`
	Placement       string         `json:"placement,omitempty"`
}
