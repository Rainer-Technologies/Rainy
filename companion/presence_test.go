package main

import (
	"testing"
	"time"
)

func TestSameShownToleratesSmallDrift(t *testing.T) {
	a := &Presence{Title: "T", Artist: "A", Start: 100, End: 300}
	if !sameShown(a, &Presence{Title: "T", Artist: "A", Start: 102, End: 302}) {
		t.Fatal("un desfase de 2 s debería contar como igual")
	}
	if sameShown(a, &Presence{Title: "T", Artist: "A", Start: 110, End: 310}) {
		t.Fatal("un seek de 10 s debería reenviarse")
	}
}

func TestPresenceForUsesServerClock(t *testing.T) {
	p := presenceFor(&Device{IsPlaying: true, SongTitle: "T", LastSeen: 1000, Position: 30, Duration: 200})
	if p == nil || p.Start != 970 || p.End != 1170 {
		t.Fatalf("start/end = %+v, esperaba 970/1170", p)
	}
}

func TestPresenceForPausedOrEmptyIsNil(t *testing.T) {
	if presenceFor(nil) != nil {
		t.Fatal("sin dispositivo debe ser nil")
	}
	if presenceFor(&Device{IsPlaying: false, SongTitle: "T"}) != nil {
		t.Fatal("pausado debe ser nil")
	}
	if presenceFor(&Device{IsPlaying: true, SongTitle: "  "}) != nil {
		t.Fatal("sin título debe ser nil")
	}
}

func TestCoverChangeCountsAsNewPresence(t *testing.T) {
	a := &Presence{Title: "T", Artist: "A", Start: 100, End: 300}
	b := &Presence{Title: "T", Artist: "A", Start: 100, End: 300, Cover: "https://x/512x512bb.jpg"}
	if sameShown(a, b) {
		t.Fatal("llegar la portada tarde debe reenviar la presencia")
	}
}

func TestSenderRespectsMinInterval(t *testing.T) {
	var s sender
	now := time.Unix(1000, 0)
	p1 := &Presence{Title: "T1", Start: 1}
	p2 := &Presence{Title: "T2", Start: 1}
	if !s.due(p1, now) {
		t.Fatal("el primer envío debe salir")
	}
	s.mark(p1, now)
	if s.due(p2, now.Add(2*time.Second)) {
		t.Fatal("dentro de 4 s no debe reenviarse")
	}
	if !s.due(p2, now.Add(5*time.Second)) {
		t.Fatal("tras 4 s debe reenviarse")
	}
}
