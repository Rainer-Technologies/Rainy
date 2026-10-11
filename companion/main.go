package main

import (
	"flag"
	"io"
	"log"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// version la fija el build de release con -ldflags "-X main.version=...".
var version = "dev"

func main() {
	serverFlag := flag.String("server", "", "URL del servidor Rainy, p. ej. 192.168.1.10:5000 o tu-dominio.com")
	flag.Parse()

	closeLog := setupLog()
	defer closeLog()
	log.Printf("Rainy Presence %s", version)

	a := &app{cfg: loadConfig(), covers: newCoverCache()}
	if *serverFlag != "" {
		a.cfg.Server = normalizeServer(*serverFlag)
	}
	if token, err := a.cfg.sessionToken(); err != nil {
		log.Printf("la sesión guardada no se puede descifrar (%v): hay que volver a entrar", err)
	} else if token != "" && a.cfg.Server != "" {
		a.client = NewConnectClient(a.cfg.Server, token)
	}
	warnIfPlainHTTP(a.cfg.Server)

	if err := a.createWindow(); err != nil {
		log.Fatal(err)
	}
	if err := a.setupTray(); err != nil {
		log.Fatal(err)
	}
	// Primer arranque sin sesión: enseña la configuración en seguida.
	if a.client == nil {
		a.mw.Synchronize(a.openSetup)
	}

	go func() {
		for range time.Tick(pollEvery) {
			a.tick()
		}
	}()

	// El bucle de mensajes corre hasta "Salir".
	a.mw.Run()
	a.onExit()
}

// setupLog escribe en %APPDATA%\RainyPresence\presence.log (y en consola si hay).
func setupLog() func() {
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return func() {}
	}
	f, err := os.OpenFile(filepath.Join(configDir(), "presence.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return func() {}
	}
	log.SetOutput(io.MultiWriter(f, os.Stderr))
	return func() { f.Close() }
}

// normalizeServer: "192.168.1.10:5000" → http://…; "tu-dominio.com" → https://…
func normalizeServer(raw string) string {
	s := strings.TrimRight(strings.TrimSpace(raw), "/")
	if s == "" || strings.Contains(s, "://") {
		return s
	}
	host := s
	if h, _, err := net.SplitHostPort(s); err == nil {
		host = h
	}
	if net.ParseIP(host) != nil || host == "localhost" {
		return "http://" + s
	}
	return "https://" + s
}

// warnIfPlainHTTP avisa cuando la contraseña iría en claro por la red.
func warnIfPlainHTTP(base string) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "http" {
		return
	}
	host := u.Hostname()
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return
	}
	log.Printf("AVISO: %s usa http://; la contraseña viaja sin cifrar en el primer login", base)
}
