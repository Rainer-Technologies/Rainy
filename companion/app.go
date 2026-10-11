package main

import (
	"errors"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lxn/walk"
)

const (
	pollEvery = 3 * time.Second
	appName   = "Rainy"
)

// app junta la ventana, la bandeja y el bucle que publica en Discord.
type app struct {
	mw     *walk.MainWindow
	notify *walk.NotifyIcon
	covers *coverCache

	// Lo toca la UI y el bucle; por eso va protegido.
	cfgMu  sync.Mutex
	cfg    config
	client *ConnectClient // nil hasta que hay sesión

	paused atomic.Bool
	// coverBroken: Discord rechazó una portada; desde entonces se publica solo con el logo.
	coverBroken bool

	// Solo se tocan desde el hilo de la UI (mw.Synchronize).
	statusAction *walk.Action
	pauseAction  *walk.Action
	setupOpen    bool

	// discord y snd los usan el bucle y la salida; mu los protege.
	mu      sync.Mutex
	discord *discordIPC
	snd     sender
}

func (a *app) currentClient() *ConnectClient {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	return a.client
}

// tick: una vuelta del bucle. Lee Connect, decide qué mostrar y lo publica si toca.
func (a *app) tick() {
	a.mu.Lock()
	defer a.mu.Unlock()

	client := a.currentClient()
	if client == nil {
		a.setStatus("No session: open Settings…")
		return
	}
	devs, err := client.Devices()
	if errors.Is(err, ErrUnauthorized) {
		a.setStatus("Session expired: open Settings…")
		return
	}
	if err != nil {
		a.setStatus("Cannot reach Rainy")
		log.Printf("Connect: %v", err)
		return
	}

	var want *Presence
	if !a.paused.Load() {
		want = presenceFor(pickPlaying(devs))
	}
	if want != nil && !a.coverBroken {
		want.Cover = a.covers.Get(want.Title, want.Artist, want.Album)
	}

	now := time.Now()
	if !a.snd.due(want, now) {
		return
	}

	if a.discord == nil {
		d, err := openDiscord()
		if err != nil {
			a.setStatus("Discord is not running")
			return
		}
		a.discord = d
	}

	err = a.discord.SetActivity(activityFor(want))
	if err != nil && want != nil && want.Cover != "" {
		// Por si Discord no acepta la URL de la portada: se reintenta con el logo.
		log.Printf("Discord rejected the cover (%v): publishing with the logo", err)
		a.coverBroken = true
		want.Cover = ""
		err = a.discord.SetActivity(activityFor(want))
	}
	if err != nil {
		log.Printf("Discord: %v", err)
		a.setStatus("Discord rejected the update; retrying")
		a.discord.Close()
		a.discord = nil
		return
	}

	a.snd.mark(want, now)
	log.Printf("published: %v", describe(want))
	a.setStatus(describe(want))
}

// onExit quita la actividad al cerrar, para no dejar "Escuchando" colgado.
func (a *app) onExit() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.discord != nil {
		_ = a.discord.SetActivity(nil)
		a.discord.Close()
		a.discord = nil
	}
	if a.notify != nil {
		_ = a.notify.Dispose()
	}
}

// setStatus actualiza el texto de la bandeja desde cualquier hilo.
func (a *app) setStatus(text string) {
	if a.paused.Load() {
		text = "Paused"
	}
	a.mw.Synchronize(func() {
		if a.statusAction != nil {
			_ = a.statusAction.SetText(text)
		}
		if a.notify != nil {
			_ = a.notify.SetToolTip(appName + " Presence — " + text)
		}
	})
}

// describe: texto corto para la bandeja y el log.
func describe(p *Presence) string {
	if p == nil {
		return "Nothing playing"
	}
	return p.Title + " — " + p.Artist
}

// activityFor: nil (limpiar) o el payload de Discord para la presencia.
func activityFor(p *Presence) *discordActivity {
	if p == nil {
		return nil
	}
	return toActivity(p)
}

// toActivity traduce la presencia al payload de Discord. Con portada, la grande
// es la carátula y el logo queda en la esquina, como en móvil.
func toActivity(p *Presence) *discordActivity {
	title := fit(p.Title)
	if title == "" {
		title = "Unknown title"
	}
	act := &discordActivity{
		Type:    2, // Listening, como en móvil
		Details: title,
		State:   fit(p.Artist),
		Buttons: []button{{Label: siteLabel, URL: siteURL}},
	}
	if p.Cover != "" {
		act.Assets = &assets{LargeImage: p.Cover, LargeText: fit(p.Album), SmallImage: logoAssetKey, SmallText: appName}
	} else {
		act.Assets = &assets{LargeImage: logoAssetKey, LargeText: fit(p.Album)}
	}
	if p.Start > 0 {
		act.Timestamps = &timestamps{Start: p.Start}
		if p.End > p.Start {
			act.Timestamps.End = p.End
		}
	}
	return act
}
