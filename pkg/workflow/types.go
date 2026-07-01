package workflow

import "time"

type Status string

const (
	StatusPending    Status = "Pending"
	StatusRunning    Status = "Running"
	StatusCompleted  Status = "Completed"
	StatusFailed     Status = "Failed"
	StatusTerminated Status = "Terminated"
	StatusSuspended  Status = "Suspended"
)

// NormalizeStatus maps a durabletask ORCHESTRATION_STATUS_* string onto the
// six dashboard statuses. Unknown / not-yet-started values map to Pending.
func NormalizeStatus(raw string) Status {
	switch raw {
	case "ORCHESTRATION_STATUS_COMPLETED":
		return StatusCompleted
	case "ORCHESTRATION_STATUS_FAILED":
		return StatusFailed
	case "ORCHESTRATION_STATUS_TERMINATED", "ORCHESTRATION_STATUS_CANCELED":
		return StatusTerminated
	case "ORCHESTRATION_STATUS_SUSPENDED":
		return StatusSuspended
	case "ORCHESTRATION_STATUS_RUNNING", "ORCHESTRATION_STATUS_CONTINUED_AS_NEW", "ORCHESTRATION_STATUS_STALLED":
		return StatusRunning
	default:
		return StatusPending
	}
}

// IsTerminal reports whether a status is final (no further events expected).
func (s Status) IsTerminal() bool {
	return s == StatusCompleted || s == StatusFailed || s == StatusTerminated
}

type FailureDetails struct {
	ErrorType string `json:"errorType,omitempty"`
	Message   string `json:"message,omitempty"`
}

type HistoryEvent struct {
	SequenceID  int32     `json:"sequenceId"`
	Timestamp   time.Time `json:"timestamp"`
	Type        string    `json:"type"`
	Name        string    `json:"name,omitempty"`
	InstanceID  string    `json:"instanceId,omitempty"`  // child instance id for SubOrchestrationCreated
	ScheduledID *int32    `json:"scheduledId,omitempty"` // start event's EventId; set on completion/fired events
	Input       *string   `json:"input,omitempty"`
	Output      *string   `json:"output,omitempty"`
}

type ExecutionSummary struct {
	AppID            string     `json:"appId"`
	InstanceID       string     `json:"instanceId"`
	Name             string     `json:"name"`
	Status           Status     `json:"status"`
	ParentInstanceID string     `json:"parentInstanceId,omitempty"` // non-empty ⇒ this is a child workflow
	CreatedAt        *time.Time `json:"createdAt,omitempty"`
	LastUpdatedAt    *time.Time `json:"lastUpdatedAt,omitempty"`
}

type Execution struct {
	ExecutionSummary
	Input          *string         `json:"input,omitempty"`
	Output         *string         `json:"output,omitempty"`
	CustomStatus   string          `json:"customStatus,omitempty"`
	ReplayCount    int             `json:"replayCount"`
	FailureDetails *FailureDetails `json:"failureDetails,omitempty"`
	History        []HistoryEvent  `json:"history"`
}

type ListResult struct {
	Items     []ExecutionSummary `json:"items"`
	NextToken string             `json:"nextToken,omitempty"`
}

type StatsResult struct {
	Counts map[Status]int `json:"counts"`
	Total  int            `json:"total"`
}
