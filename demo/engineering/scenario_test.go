package main

import "testing"

func TestScenario(t *testing.T) {
	got := Scenario()
	if len(got) != 6 {
		t.Fatalf("want 6 sweeps, got %d", len(got))
	}
	byID := map[string]Sweep{}
	for _, s := range got {
		byID[s.ID] = s
	}
	for _, id := range []string{"sweep-001", "sweep-003", "sweep-004", "sweep-006"} {
		if byID[id].Outcome != Complete {
			t.Errorf("%s: want Complete, got %q", id, byID[id].Outcome)
		}
	}
	s2 := byID["sweep-002"]
	if s2.Outcome != Fail || s2.Subsystem != "deflector" || s2.Message != "plasma conduit rupture in deck 7" {
		t.Errorf("sweep-002 wrong: %+v", s2)
	}
	s5 := byID["sweep-005"]
	if s5.Outcome != AwaitSignOff || s5.EventName != "ChiefEngineerSignOff" {
		t.Errorf("sweep-005 wrong: %+v", s5)
	}
	for id, s := range byID {
		if s.LargePayload != (id == "sweep-006") {
			t.Errorf("%s: LargePayload=%v", id, s.LargePayload)
		}
	}
}

func TestChildID(t *testing.T) {
	if got := ChildID("sweep-002", "deflector"); got != "sweep-002-deflector" {
		t.Fatalf("got %q", got)
	}
}
