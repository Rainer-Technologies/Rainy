package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeRainy imita las rutas de auth de Rainy (routes/auth.py) con un usuario válido.
func fakeRainy(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != userAgent {
			t.Errorf("User-Agent = %q, esperaba %q", r.Header.Get("User-Agent"), userAgent)
		}
		switch r.URL.Path {
		case "/api/auth/me":
			c, err := r.Cookie("session")
			if err != nil || c.Value != "ok" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte(`{"authenticated":false}`))
				return
			}
			w.Write([]byte(`{"authenticated":true,"user":{"username":"ferri"}}`))
		case "/api/auth/login":
			if r.Method != http.MethodPost {
				http.NotFound(w, r)
				return
			}
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "ok", Path: "/"})
			w.Write([]byte(`{"success":true,"user":{"username":"ferri"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestCheckServerAcceptsRainy(t *testing.T) {
	srv := fakeRainy(t)
	defer srv.Close()
	if err := NewConnectClient(srv.URL, "").CheckServer(); err != nil {
		t.Fatalf("CheckServer: %v", err)
	}
}

func TestCheckServerRejectsOtherSites(t *testing.T) {
	// Un servidor cualquiera responde 404 HTML a esa ruta.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()
	if err := NewConnectClient(srv.URL, "").CheckServer(); !errors.Is(err, ErrNotRainy) {
		t.Fatalf("err = %v, esperaba ErrNotRainy", err)
	}
}

func TestCheckServerReportsUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // ya no escucha
	if err := NewConnectClient(url, "").CheckServer(); err == nil {
		t.Fatal("esperaba error con el servidor apagado")
	}
}

func TestLoginReturnsSessionAndUsername(t *testing.T) {
	srv := fakeRainy(t)
	defer srv.Close()
	token, user, err := NewConnectClient(srv.URL, "").Login("a@b.c", "pw")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if token != "ok" || user != "ferri" {
		t.Fatalf("token=%q user=%q", token, user)
	}
}

func TestLoginRejectsBadPassword(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	if _, _, err := NewConnectClient(srv.URL, "").Login("a@b.c", "mal"); err == nil {
		t.Fatal("esperaba error con contraseña incorrecta")
	}
}

func TestMeValidatesSession(t *testing.T) {
	srv := fakeRainy(t)
	defer srv.Close()

	user, err := NewConnectClient(srv.URL, "ok").Me()
	if err != nil || user != "ferri" {
		t.Fatalf("Me = %q, %v", user, err)
	}
	if _, err := NewConnectClient(srv.URL, "caducada").Me(); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("err = %v, esperaba ErrUnauthorized", err)
	}
}

func TestDevicesDecodesAndDetectsExpiredSession(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c, err := r.Cookie("session"); err != nil || c.Value != "ok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"devices":[{"device_id":"d1","device_type":"web","song_title":"T","song_artist":"A","is_playing":true,"position":12,"duration":200,"last_seen":1000}]}`))
	}))
	defer srv.Close()

	devs, err := NewConnectClient(srv.URL, "ok").Devices()
	if err != nil {
		t.Fatalf("Devices: %v", err)
	}
	if len(devs) != 1 || devs[0].SongTitle != "T" || !devs[0].IsPlaying || devs[0].LastSeen != 1000 {
		t.Fatalf("devices = %+v", devs)
	}
	if _, err := NewConnectClient(srv.URL, "caducada").Devices(); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("err = %v, esperaba ErrUnauthorized", err)
	}
}
