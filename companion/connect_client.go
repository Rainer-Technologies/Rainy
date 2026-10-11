package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const userAgent = "RainyPresence/0.1"

// ErrUnauthorized: la sesión caducó o se revocó en el servidor; hay que volver a entrar.
var ErrUnauthorized = errors.New("session expired")

// ErrNotRainy: el servidor responde, pero no como Rainy.
var ErrNotRainy = errors.New("that server does not look like Rainy")

// Device es un elemento de GET /api/connect/devices (models/connect.py _serialize).
type Device struct {
	DeviceID   string  `json:"device_id"`
	DeviceType string  `json:"device_type"`
	SongTitle  string  `json:"song_title"`
	SongArtist string  `json:"song_artist"`
	SongAlbum  string  `json:"song_album"`
	Position   float64 `json:"position"`
	Duration   float64 `json:"duration"`
	IsPlaying  bool    `json:"is_playing"`
	LastSeen   float64 `json:"last_seen"`
}

type ConnectClient struct {
	base   string
	cookie string
	http   *http.Client
}

func NewConnectClient(base, cookie string) *ConnectClient {
	return &ConnectClient{
		base:   base,
		cookie: cookie,
		http:   &http.Client{Timeout: 10 * time.Second},
	}
}

// newRequest prepara una petición con la cabecera de identificación y, si hay, la cookie.
func (c *ConnectClient) newRequest(method, path string, body []byte) (*http.Request, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, c.base+path, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.cookie != "" {
		req.Header.Set("Cookie", "session="+c.cookie)
	}
	return req, nil
}

// CheckServer comprueba que la URL es un servidor Rainy. Rainy responde 401 con
// {"authenticated": false} a /api/auth/me cuando no hay sesión.
func (c *ConnectClient) CheckServer() error {
	req, err := c.newRequest(http.MethodGet, "/api/auth/me", nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("no response from %s: %w", c.base, err)
	}
	defer resp.Body.Close()

	var body struct {
		Authenticated *bool `json:"authenticated"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if resp.StatusCode == http.StatusUnauthorized && body.Authenticated != nil {
		return nil
	}
	if resp.StatusCode == http.StatusNotFound || body.Authenticated == nil {
		return ErrNotRainy
	}
	return fmt.Errorf("server responded with HTTP %d", resp.StatusCode)
}

// Login devuelve la cookie de sesión y el nombre de usuario. La contraseña no se guarda.
func (c *ConnectClient) Login(email, password string) (token, username string, err error) {
	body, err := json.Marshal(map[string]string{"email": email, "password": password})
	if err != nil {
		return "", "", err
	}
	req, err := c.newRequest(http.MethodPost, "/api/auth/login", body)
	if err != nil {
		return "", "", err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("no response from %s: %w", c.base, err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return "", "", errors.New("wrong email or password")
	case http.StatusTooManyRequests:
		return "", "", errors.New("too many failed attempts; wait a while")
	case http.StatusBadRequest:
		return "", "", errors.New("the server rejected the data")
	default:
		return "", "", fmt.Errorf("login: HTTP %d", resp.StatusCode)
	}

	var out struct {
		User struct {
			Username string `json:"username"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", "", fmt.Errorf("unexpected login response: %w", err)
	}
	for _, ck := range resp.Cookies() {
		if ck.Name == "session" {
			return ck.Value, out.User.Username, nil
		}
	}
	return "", "", errors.New("the server did not return a session cookie")
}

// Me valida la sesión actual y devuelve el nombre de usuario.
func (c *ConnectClient) Me() (string, error) {
	req, err := c.newRequest(http.MethodGet, "/api/auth/me", nil)
	if err != nil {
		return "", err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("no response from %s: %w", c.base, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return "", ErrUnauthorized
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("me: HTTP %d", resp.StatusCode)
	}
	var out struct {
		User struct {
			Username string `json:"username"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.User.Username, nil
}

// Devices devuelve los dispositivos activos, ordenados por last_seen (más reciente primero).
func (c *ConnectClient) Devices() ([]Device, error) {
	req, err := c.newRequest(http.MethodGet, "/api/connect/devices", nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, ErrUnauthorized
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("devices: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Devices []Device `json:"devices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Devices, nil
}
