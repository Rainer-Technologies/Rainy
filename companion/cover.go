package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Port de lib/services/public_cover_lookup.dart. Discord necesita una URL que
// sus servidores puedan cargar; las portadas de Rainy están detrás de la sesión.

const (
	itunesEndpoint = "https://itunes.apple.com/search"
	coverTimeout   = 4 * time.Second
	coverRetry     = time.Minute // un fallo de red no se reintenta antes de esto
	coverMaxSongs  = 200
)

var (
	artistSplit = regexp.MustCompile(`(?i),|;|/|&| feat\.? | ft\.? | x `)
	asides      = regexp.MustCompile(`\([^)]*\)|\[[^\]]*\]`)
	nonWord     = regexp.MustCompile(`[^\p{L}\p{N}]+`)
)

type itunesResult struct {
	TrackName      string `json:"trackName"`
	ArtistName     string `json:"artistName"`
	CollectionName string `json:"collectionName"`
	ArtworkURL100  string `json:"artworkUrl100"`
}

// firstArtist: "A, B" / "A feat. B" → "A".
func firstArtist(artist string) string {
	return strings.TrimSpace(artistSplit.Split(artist, -1)[0])
}

// plain: minúsculas, sin paréntesis ni corchetes, solo letras y dígitos.
func plain(text string) string {
	t := strings.ToLower(text)
	t = asides.ReplaceAllString(t, " ")
	return nonWord.ReplaceAllString(t, "")
}

func alike(a, b string) bool {
	return a != "" && b != "" && (strings.Contains(a, b) || strings.Contains(b, a))
}

// pickCover elige la portada del mismo tema; prefiere el mismo álbum.
// Cualquier cosa más laxa podría mostrar la portada de otro disco.
func pickCover(title, artist, album string, results []itunesResult) string {
	t := plain(title)
	a := plain(firstArtist(artist))
	al := plain(album)
	fallback := ""
	for _, r := range results {
		if r.ArtworkURL100 == "" {
			continue
		}
		if !alike(t, plain(r.TrackName)) {
			continue
		}
		if a != "" && !alike(a, plain(r.ArtistName)) {
			continue
		}
		u := strings.Replace(r.ArtworkURL100, "100x100bb.", "512x512bb.", 1)
		if al != "" && alike(al, plain(r.CollectionName)) {
			return u
		}
		if fallback == "" {
			fallback = u
		}
	}
	return fallback
}

type coverEntry struct {
	url    string
	at     time.Time
	failed bool
}

// coverCache guarda cada búsqueda (también las que no dieron nada) para no
// preguntar a iTunes dos veces por la misma canción.
type coverCache struct {
	mu       sync.Mutex
	client   *http.Client
	endpoint string
	entries  map[string]coverEntry
}

func newCoverCache() *coverCache {
	return &coverCache{
		client:   &http.Client{Timeout: coverTimeout},
		endpoint: itunesEndpoint,
		entries:  map[string]coverEntry{},
	}
}

// Get devuelve la URL de la portada o "" si no hay una convincente.
func (c *coverCache) Get(title, artist, album string) string {
	if strings.TrimSpace(title) == "" {
		return ""
	}
	key := artist + "\n" + title + "\n" + album

	c.mu.Lock()
	e, ok := c.entries[key]
	c.mu.Unlock()
	if ok && (!e.failed || time.Since(e.at) < coverRetry) {
		return e.url
	}

	found, err := c.search(title, artist, album)

	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= coverMaxSongs {
		c.entries = map[string]coverEntry{}
	}
	if err != nil {
		c.entries[key] = coverEntry{failed: true, at: time.Now()}
		return ""
	}
	c.entries[key] = coverEntry{url: found, at: time.Now()}
	return found
}

func (c *coverCache) search(title, artist, album string) (string, error) {
	term := strings.TrimSpace(firstArtist(artist) + " " + title)
	q := url.Values{"term": {term}, "entity": {"song"}, "limit": {"8"}}
	resp, err := c.client.Get(c.endpoint + "?" + q.Encode())
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("itunes: HTTP %d", resp.StatusCode)
	}
	var body struct {
		Results []itunesResult `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	return pickCover(title, artist, album, body.Results), nil
}
