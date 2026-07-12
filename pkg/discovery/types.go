package discovery

// Health represents the health status of an instance
type Health string

const (
	HealthHealthy   Health = "healthy"
	HealthStarting  Health = "starting"
	HealthUnhealthy Health = "unhealthy"
	HealthUnknown   Health = "unknown"
)

// Per-target process status. Empty string means unknown.
const (
	StatusRunning = "running"
	StatusStopped = "stopped"
)

// Instance represents a running application instance with Dapr
type Instance struct {
	AppID string `json:"appId"`
	// InstanceKey is the routing identity: container name for compose apps
	// (falling back to app id), app id otherwise. Unique per instance even
	// when several compose sidecars share one -app-id.
	InstanceKey        string `json:"instanceKey"`
	Health             Health `json:"health"`
	Runtime            string `json:"runtime"`            // e.g. "go", "python", "node", "dotnet", "java", "rust", "unknown"
	IsAspire           bool   `json:"isAspire,omitempty"` // true when the app is .NET Aspire-managed
	Source             string `json:"source"`             // "standalone" | "compose" | "aspire"
	ComposeProject     string `json:"composeProject,omitempty"`
	ComposeService     string `json:"composeService,omitempty"`
	DaprdContainerID   string `json:"daprdContainerId,omitempty"`
	DaprdContainerName string `json:"daprdContainerName,omitempty"`
	AppContainerID     string `json:"appContainerId,omitempty"`
	AppContainerName   string `json:"appContainerName,omitempty"`
	SidecarReachable   bool   `json:"sidecarReachable"`
	// DaprHTTPBaseURL is the daprd HTTP endpoint for aspire-source apps
	// ("" otherwise; consumers fall back to 127.0.0.1:httpPort).
	DaprHTTPBaseURL string `json:"daprHttpBaseUrl,omitempty"`
	Namespace       string `json:"namespace,omitempty"`
	Label           string `json:"label,omitempty"`

	// TestcontainersSession groups one Testcontainers run's containers
	// (org.testcontainers.sessionId label; "" for other sources).
	TestcontainersSession string `json:"testcontainersSession,omitempty"`

	HTTPPort       int    `json:"httpPort"`
	GRPCPort       int    `json:"grpcPort"`
	AppPort        int    `json:"appPort"`
	DaprdPID       int    `json:"daprdPid"`
	AppPID         int    `json:"appPid"` // 0 = unknown
	CLIPID         int    `json:"cliPid"`
	AppStatus      string `json:"appStatus,omitempty"`      // "running" | "stopped"; "" unknown
	DaprdStatus    string `json:"daprdStatus,omitempty"`    // "running" | "stopped"; "" unknown
	AppStartedAt   string `json:"appStartedAt,omitempty"`   // RFC3339 UTC; "" when stopped/unknown
	DaprdStartedAt string `json:"daprdStartedAt,omitempty"` // RFC3339 UTC; "" when stopped/unknown
	// SidecarOrphaned marks a standalone daprd with no supervising dapr CLI
	// and no live app (e.g. an external stop missed a detached sidecar).
	SidecarOrphaned bool           `json:"sidecarOrphaned,omitempty"`
	Age             string         `json:"age"`     // human, e.g. "14m"
	Created         string         `json:"created"` // local time string
	RunTemplate     string         `json:"runTemplate"`
	ResourcePaths   []string       `json:"resourcePaths"`
	ConfigPath      string         `json:"configPath"`
	AppLogPath      string         `json:"appLogPath"`
	DaprdLogPath    string         `json:"daprdLogPath"`
	AppLogFormat    string         `json:"appLogFormat,omitempty"`   // "" / "plain" / "dcp"
	DaprdLogFormat  string         `json:"daprdLogFormat,omitempty"` // "" / "plain" / "dcp"
	Command         string         `json:"command"`
	RuntimeVersion  string         `json:"runtimeVersion"` // from metadata; "" if unavailable
	MetadataOK      bool           `json:"metadataOk"`     // false if /v1.0/metadata failed
	Actors          []ActorType    `json:"actors,omitempty"`
	Subscriptions   []Subscription `json:"subscriptions,omitempty"`
	Components      []Component    `json:"components,omitempty"`
	EnabledFeatures []string       `json:"enabledFeatures,omitempty"`
	Placement       string         `json:"placement,omitempty"`
}
