package controlplane

import (
	"bytes"
	"encoding/json"
	"math"
	"path"
	"sort"
	"strconv"
	"strings"
)

type inspectData struct {
	State   ServiceStatus
	Healthy bool
	Ports   []string
	LogPath string
}

// rawInspect mirrors the subset of `<runtime> inspect` we consume.
type rawInspect struct {
	ID   string `json:"Id"`
	Name string `json:"Name"`
	State struct {
		Status string `json:"Status"`
		Health struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	Config struct {
		Labels     map[string]string `json:"Labels"`
		Entrypoint []string          `json:"Entrypoint"`
		Cmd        []string          `json:"Cmd"`
	} `json:"Config"`
	NetworkSettings struct {
		Ports map[string]any `json:"Ports"`
	} `json:"NetworkSettings"`
	LogPath string `json:"LogPath"`
}

func parseInspect(data []byte) (inspectData, error) {
	var arr []rawInspect
	if err := json.Unmarshal(data, &arr); err != nil {
		return inspectData{}, err
	}
	if len(arr) == 0 {
		return inspectData{State: StatusUnknown}, nil
	}
	c := arr[0]
	out := inspectData{LogPath: c.LogPath}
	running := c.State.Status == "running"
	if running {
		out.State = StatusRunning
	} else {
		out.State = StatusStopped
	}
	h := c.State.Health.Status
	out.Healthy = running && (h == "" || h == "healthy")
	for p := range c.NetworkSettings.Ports {
		out.Ports = append(out.Ports, p)
	}
	sort.Strings(out.Ports)
	return out, nil
}

// parseComposeControlPlane extracts compose-managed placement/scheduler
// containers from a batched inspect payload.
func parseComposeControlPlane(data []byte) ([]Service, error) {
	var arr []rawInspect
	if err := json.Unmarshal(data, &arr); err != nil {
		return nil, err
	}
	var out []Service
	for _, c := range arr {
		project := c.Config.Labels["com.docker.compose.project"]
		if project == "" || !isControlPlaneCommand(c.Config.Entrypoint, c.Config.Cmd) {
			continue
		}
		svc := Service{
			Name:           strings.TrimPrefix(c.Name, "/"),
			ComposeProject: project,
			Actionable:     true,
			LogPath:        c.LogPath,
		}
		running := c.State.Status == "running"
		if running {
			svc.Status = StatusRunning
		} else {
			svc.Status = StatusStopped
		}
		h := c.State.Health.Status
		svc.Healthy = running && (h == "" || h == "healthy")
		for p := range c.NetworkSettings.Ports {
			svc.Ports = append(svc.Ports, p)
		}
		sort.Strings(svc.Ports)
		if svc.Ports == nil {
			svc.Ports = []string{}
		}
		out = append(out, svc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// isControlPlaneCommand reports whether argv (entrypoint+cmd) launches the
// Dapr placement or scheduler binary.
func isControlPlaneCommand(entrypoint, cmd []string) bool {
	argv := append(append([]string{}, entrypoint...), cmd...)
	if len(argv) == 0 {
		return false
	}
	switch path.Base(argv[0]) {
	case "placement", "scheduler":
		return true
	default:
		return false
	}
}

type memStat struct {
	Bytes uint64
	Human string
}

// parseMemUsage converts the used side of a docker/podman MemUsage string
// (e.g. "12.34MiB / 7.667GiB") into bytes. Returns 0 on any parse failure.
func parseMemUsage(s string) uint64 {
	used := strings.TrimSpace(strings.SplitN(s, "/", 2)[0])
	units := []struct {
		suffix string
		mult   float64
	}{
		{"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10},
		{"GB", 1e9}, {"MB", 1e6}, {"kB", 1e3}, {"B", 1},
	}
	for _, u := range units {
		if strings.HasSuffix(used, u.suffix) {
			num := strings.TrimSpace(strings.TrimSuffix(used, u.suffix))
			f, err := strconv.ParseFloat(num, 64)
			if err != nil {
				return 0
			}
			return uint64(math.Round(f * u.mult))
		}
	}
	return 0
}

// rawStat mirrors one `<runtime> stats --format '{{json .}}'` line.
type rawStat struct {
	Name     string `json:"Name"`
	MemUsage string `json:"MemUsage"`
}

func parseStats(data []byte) map[string]memStat {
	out := map[string]memStat{}
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var r rawStat
		if err := json.Unmarshal(line, &r); err != nil || r.Name == "" {
			continue
		}
		used := strings.TrimSpace(strings.SplitN(r.MemUsage, "/", 2)[0])
		out[r.Name] = memStat{Bytes: parseMemUsage(r.MemUsage), Human: used}
	}
	return out
}
