package main

import (
	"math"
	"strings"
	"time"
)

// Mismos números que lib/services/discord_presence_service.dart.
const (
	minInterval   = 4 * time.Second // Discord: ~5 actualizaciones por 20 s
	seekTolerance = 3.0             // segundos
	// Clave del asset del logo en el Developer Portal. Por IPC Discord busca los
	// assets por clave (el ID del móvil no se resuelve aquí).
	logoAssetKey = "logo"
	siteURL      = "https://getrainy.com"
	siteLabel    = "Get Rainy"
)

// Presence es lo que Discord debe mostrar. nil = nada (limpiar).
// Start y End son segundos Unix; End = 0 significa sin barra de fin.
// Cover es la URL pública de la portada, o "" si no hay (se muestra el logo).
type Presence struct {
	Title, Artist, Album string
	Start, End           int64
	Cover                string
}

func (p *Presence) textKey() string {
	return p.Title + "\n" + p.Artist + "\n" + p.Album
}

// sameShown: mismo texto y barra alineada dentro de la tolerancia (como _same en Dart).
func sameShown(a, b *Presence) bool {
	if a == nil || b == nil {
		return a == b
	}
	if a.textKey() != b.textKey() || a.Cover != b.Cover {
		return false
	}
	if math.Abs(float64(a.Start-b.Start)) > seekTolerance {
		return false
	}
	if a.End == 0 || b.End == 0 {
		return a.End == b.End
	}
	return math.Abs(float64(a.End-b.End)) <= seekTolerance
}

// presenceFor traduce el dispositivo que suena. Start sale del reloj del servidor
// (last_seen), así que no depende del reloj de este PC.
func presenceFor(d *Device) *Presence {
	if d == nil || !d.IsPlaying || strings.TrimSpace(d.SongTitle) == "" {
		return nil
	}
	start := int64(math.Round(d.LastSeen - d.Position))
	p := &Presence{Title: d.SongTitle, Artist: d.SongArtist, Album: d.SongAlbum, Start: start}
	if d.Duration > 0 {
		p.End = start + int64(math.Round(d.Duration))
	}
	return p
}

// pickPlaying: la lista llega ordenada por last_seen DESC, así que gana el primero que suena.
func pickPlaying(devs []Device) *Device {
	for i := range devs {
		if devs[i].IsPlaying {
			return &devs[i]
		}
	}
	return nil
}

// sender decide cuándo toca enviar. Antirrebote simple: no repite lo que ya se muestra
// y respeta el intervalo mínimo entre envíos.
type sender struct {
	sent   *Presence
	sentAt time.Time
}

func (s *sender) due(want *Presence, now time.Time) bool {
	if sameShown(want, s.sent) {
		return false
	}
	if s.sent != nil && now.Sub(s.sentAt) < minInterval {
		return false
	}
	return true
}

// mark se llama solo cuando Discord confirmó el envío.
func (s *sender) mark(want *Presence, now time.Time) {
	s.sent = want
	s.sentAt = now
}

// fit: Discord acepta 2–128 caracteres por campo.
func fit(text string) string {
	s := strings.TrimSpace(text)
	r := []rune(s)
	if len(r) > 128 {
		return string(r[:127]) + "…"
	}
	if len(r) == 1 {
		return s + " "
	}
	return s
}
