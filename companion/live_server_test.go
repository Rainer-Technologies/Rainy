package main

import (
	"net/http"
	"os"
	"testing"
)

// Prueba contra un servidor Rainy real. Solo corre si defines, en el entorno del proceso:
//
//	RAINY_LIVE_SERVER   URL del servidor, p. ej. http://192.168.1.10:5000
//	RAINY_LIVE_EMAIL    email de la cuenta
//	RAINY_LIVE_PASSWORD contraseña de la cuenta
//
// No guarda nada en disco y cierra la sesión de prueba al terminar.
func TestLiveRainyServer(t *testing.T) {
	base := os.Getenv("RAINY_LIVE_SERVER")
	email := os.Getenv("RAINY_LIVE_EMAIL")
	password := os.Getenv("RAINY_LIVE_PASSWORD")
	if base == "" || email == "" || password == "" {
		t.Skip("define RAINY_LIVE_SERVER, RAINY_LIVE_EMAIL y RAINY_LIVE_PASSWORD")
	}

	client := NewConnectClient(base, "")
	if err := client.CheckServer(); err != nil {
		t.Fatalf("paso 1, CheckServer: %v", err)
	}

	token, username, err := client.Login(email, password)
	if err != nil {
		t.Fatalf("paso 2, Login: %v", err)
	}
	if username == "" {
		t.Fatal("paso 2, Login no devolvió nombre de usuario")
	}
	t.Logf("login correcto como %q", username)

	client.cookie = token
	me, err := client.Me()
	if err != nil {
		t.Fatalf("paso 3, Me: %v", err)
	}
	if me != username {
		t.Fatalf("Me = %q, Login = %q", me, username)
	}

	// Cerrar la sesión que acabamos de abrir.
	req, err := client.newRequest(http.MethodPost, "/api/auth/logout", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.http.Do(req)
	if err != nil {
		t.Fatalf("logout: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("logout: HTTP %d", resp.StatusCode)
	}
}
