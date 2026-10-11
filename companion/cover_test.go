package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

func TestFirstArtist(t *testing.T) {
	cases := map[string]string{
		"A, B":            "A",
		"Artista feat. X": "Artista",
		"Foo x Bar":       "Foo",
		"Solo":            "Solo",
		"":                "",
	}
	for in, want := range cases {
		if got := firstArtist(in); got != want {
			t.Errorf("firstArtist(%q) = %q, esperaba %q", in, got, want)
		}
	}
}

func TestPickCoverPrefersSameAlbum(t *testing.T) {
	results := []itunesResult{
		{TrackName: "Otra", ArtistName: "Band", CollectionName: "Disco", ArtworkURL100: "https://x/a/100x100bb.jpg"},
		{TrackName: "Tema (Remaster)", ArtistName: "Band", CollectionName: "Recopilatorio", ArtworkURL100: "https://x/b/100x100bb.jpg"},
		{TrackName: "Tema", ArtistName: "Band", CollectionName: "Disco", ArtworkURL100: "https://x/c/100x100bb.jpg"},
	}
	got := pickCover("Tema", "Band", "Disco", results)
	if got != "https://x/c/512x512bb.jpg" {
		t.Fatalf("pickCover = %q, esperaba la portada del mismo álbum en 512px", got)
	}
}

func TestPickCoverFallsBackToSameTrack(t *testing.T) {
	results := []itunesResult{
		{TrackName: "Tema", ArtistName: "Band", CollectionName: "Otro", ArtworkURL100: "https://x/b/100x100bb.jpg"},
	}
	if got := pickCover("Tema", "Band", "Disco", results); got != "https://x/b/512x512bb.jpg" {
		t.Fatalf("pickCover = %q, esperaba el fallback del mismo tema", got)
	}
}

func TestPickCoverRejectsOtherArtist(t *testing.T) {
	results := []itunesResult{
		{TrackName: "Tema", ArtistName: "Otro artista", CollectionName: "Disco", ArtworkURL100: "https://x/z/100x100bb.jpg"},
	}
	if got := pickCover("Tema", "Band", "Disco", results); got != "" {
		t.Fatalf("pickCover = %q, no debía elegir la portada de otro artista", got)
	}
}

func TestCoverCacheRemembersFailures(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := newCoverCache()
	c.endpoint = srv.URL
	if got := c.Get("Tema", "Band", "Disco"); got != "" {
		t.Fatalf("Get = %q, esperaba vacío con el servidor caído", got)
	}
	if got := c.Get("Tema", "Band", "Disco"); got != "" {
		t.Fatalf("segunda Get = %q, esperaba vacío", got)
	}
	if n := hits.Load(); n != 1 {
		t.Fatalf("iTunes se consultó %d veces; el fallo debía recordarse (1)", n)
	}
}

// Consulta real a iTunes. Solo con RAINY_LIVE=1, para no depender de la red en los tests normales.
func TestLiveITunesCover(t *testing.T) {
	if os.Getenv("RAINY_LIVE") != "1" {
		t.Skip("define RAINY_LIVE=1 para consultar iTunes de verdad")
	}
	c := newCoverCache()
	got := c.Get("Bohemian Rhapsody", "Queen", "A Night at the Opera")
	if !strings.HasPrefix(got, "https://") || !strings.Contains(got, "512x512bb") {
		t.Fatalf("Get = %q, esperaba una URL https de 512px", got)
	}
}
