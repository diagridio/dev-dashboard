package discovery

import (
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	labelComposeProject = "com.docker.compose.project"
	labelComposeService = "com.docker.compose.service"
)

// composeContainer is the parsed subset of `docker inspect` for one
// compose-managed container.
type composeContainer struct {
	ID        string
	Name      string
	Image     string
	Project   string
	Service   string
	Running   bool
	StartedAt time.Time
	Argv      []string          // entrypoint + cmd
	Ports     map[int]int       // container tcp port -> published host port
	Mounts    map[string]string // container destination -> host source (bind only)
}

// rawComposeContainer mirrors the subset of `<runtime> inspect` we consume.
type rawComposeContainer struct {
	ID    string `json:"Id"`
	Name  string `json:"Name"`
	State struct {
		Status    string `json:"Status"`
		StartedAt string `json:"StartedAt"`
	} `json:"State"`
	Config struct {
		Image      string            `json:"Image"`
		Labels     map[string]string `json:"Labels"`
		Entrypoint []string          `json:"Entrypoint"`
		Cmd        []string          `json:"Cmd"`
	} `json:"Config"`
	NetworkSettings struct {
		Ports map[string][]struct {
			HostPort string `json:"HostPort"`
		} `json:"Ports"`
	} `json:"NetworkSettings"`
	Mounts []struct {
		Type        string `json:"Type"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
	} `json:"Mounts"`
}

// parseComposeContainers decodes a batched inspect array, keeping only
// compose-labelled containers.
func parseComposeContainers(data []byte) ([]composeContainer, error) {
	var raw []rawComposeContainer
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	out := make([]composeContainer, 0, len(raw))
	for _, r := range raw {
		project := r.Config.Labels[labelComposeProject]
		if project == "" {
			continue
		}
		c := composeContainer{
			ID:      r.ID,
			Name:    strings.TrimPrefix(r.Name, "/"),
			Image:   r.Config.Image,
			Project: project,
			Service: r.Config.Labels[labelComposeService],
			Running: r.State.Status == "running",
			Argv:    append(append([]string{}, r.Config.Entrypoint...), r.Config.Cmd...),
			Ports:   map[int]int{},
			Mounts:  map[string]string{},
		}
		c.StartedAt, _ = time.Parse(time.RFC3339Nano, r.State.StartedAt)
		for spec, bindings := range r.NetworkSettings.Ports {
			proto := strings.SplitN(spec, "/", 2)
			if len(proto) != 2 || proto[1] != "tcp" || len(bindings) == 0 {
				continue
			}
			cp, err1 := strconv.Atoi(proto[0])
			hp, err2 := strconv.Atoi(bindings[0].HostPort)
			if err1 != nil || err2 != nil {
				continue
			}
			c.Ports[cp] = hp
		}
		for _, m := range r.Mounts {
			if m.Type == "bind" {
				c.Mounts[m.Destination] = m.Source
			}
		}
		out = append(out, c)
	}
	return out, nil
}

// TranslateMountPath maps a container-internal path to its host path via a
// bind-mount table (exact destination match or destination-prefix match).
// Container paths are always slash-separated (Linux containers).
func TranslateMountPath(mounts map[string]string, containerPath string) (string, bool) {
	p := strings.TrimSuffix(containerPath, "/")
	for dest, src := range mounts {
		d := strings.TrimSuffix(dest, "/")
		if p == d {
			return src, true
		}
		if strings.HasPrefix(p, d+"/") {
			return filepath.Join(src, filepath.FromSlash(strings.TrimPrefix(p, d+"/"))), true
		}
	}
	return "", false
}
