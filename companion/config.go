package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
)

type config struct {
	Server string `json:"server"`
	// Blob DPAPI en base64: la cookie de sesión cifrada para esta cuenta de Windows.
	// La contraseña nunca se guarda.
	Session string `json:"session"`
}

func configDir() string {
	dir, err := os.UserConfigDir() // %APPDATA% en Windows
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "RainyPresence")
}

func loadConfig() config {
	var cfg config
	data, err := os.ReadFile(filepath.Join(configDir(), "config.json"))
	if err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	return cfg
}

func saveConfig(cfg config) error {
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(configDir(), "config.json"), data, 0o600)
}

// sessionToken descifra la cookie guardada. Vacío si no hay ninguna.
func (cfg config) sessionToken() (string, error) {
	if cfg.Session == "" {
		return "", nil
	}
	blob, err := base64.StdEncoding.DecodeString(cfg.Session)
	if err != nil {
		return "", err
	}
	plain, err := unprotect(blob)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// setSessionToken cifra la cookie y la deja lista en cfg (sin guardar en disco).
func (cfg *config) setSessionToken(token string) error {
	blob, err := protect([]byte(token))
	if err != nil {
		return err
	}
	cfg.Session = base64.StdEncoding.EncodeToString(blob)
	return nil
}
