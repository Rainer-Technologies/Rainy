package main

import (
	_ "embed"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/lxn/walk"
	. "github.com/lxn/walk/declarative"
	"github.com/lxn/win"
)

//go:embed assets/icon.ico
var trayIconData []byte

const (
	hintServer  = "Examples: 192.168.1.10:5000 · rainy.example.com"
	hintAccount = "The password is not saved; the session is encrypted with your Windows account."
)

// createWindow crea la ventana principal oculta: walk necesita una para su bucle de mensajes.
// Sin Layout, walk se cae al cerrar un diálogo con ella de dueña (puntero nulo al reajustar).
func (a *app) createWindow() error {
	return MainWindow{
		AssignTo: &a.mw,
		Title:    appName + " Presence",
		Visible:  false,
		Layout:   VBox{},
	}.Create()
}

// setupTray pone el icono en la bandeja con su menú.
func (a *app) setupTray() error {
	iconPath := filepath.Join(configDir(), "tray.ico")
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(iconPath, trayIconData, 0o600); err != nil {
		return err
	}
	icon, err := walk.NewIconFromFile(iconPath)
	if err != nil {
		return err
	}
	ni, err := walk.NewNotifyIcon(a.mw)
	if err != nil {
		return err
	}
	a.notify = ni
	if err := ni.SetIcon(icon); err != nil {
		return err
	}
	if err := ni.SetToolTip(appName + " Presence"); err != nil {
		return err
	}

	menu := ni.ContextMenu().Actions()

	a.statusAction = walk.NewAction()
	_ = a.statusAction.SetText("Not configured")
	_ = a.statusAction.SetEnabled(false)
	_ = menu.Add(a.statusAction)
	_ = menu.Add(walk.NewSeparatorAction())

	a.pauseAction = walk.NewAction()
	_ = a.pauseAction.SetText("Pause publishing")
	a.pauseAction.Triggered().Attach(a.togglePause)
	_ = menu.Add(a.pauseAction)

	configure := walk.NewAction()
	_ = configure.SetText("Settings…")
	configure.Triggered().Attach(a.openSetup)
	_ = menu.Add(configure)

	_ = menu.Add(walk.NewSeparatorAction())
	quit := walk.NewAction()
	_ = quit.SetText("Quit")
	quit.Triggered().Attach(func() { a.mw.Close() })
	_ = menu.Add(quit)

	return ni.SetVisible(true)
}

func (a *app) togglePause() {
	paused := !a.paused.Load()
	a.paused.Store(paused)
	if paused {
		_ = a.pauseAction.SetText("Resume publishing")
	} else {
		_ = a.pauseAction.SetText("Pause publishing")
	}
}

// openSetup abre una única ventana de configuración con dos páginas: 1) servidor, 2) cuenta.
// Pasar de una a otra cambia el contenido de la misma ventana; no se cierra ni se reabre.
func (a *app) openSetup() {
	if a.setupOpen {
		return
	}
	a.setupOpen = true
	// walk vuelve a mostrar la ventana principal oculta al cerrar un diálogo; la ocultamos de nuevo.
	defer func() {
		a.setupOpen = false
		a.mw.SetVisible(false)
	}()

	a.cfgMu.Lock()
	server := a.cfg.Server
	a.cfgMu.Unlock()

	var dlg *walk.Dialog
	var serverLE, emailLE, passLE *walk.LineEdit
	var msg *walk.TextLabel
	var serverLabel *walk.Label
	var serverPage, accountPage *walk.Composite
	var nextBtn, loginBtn, backBtn, cancelBtn *walk.PushButton
	var chosen string

	decl := Dialog{
		AssignTo:      &dlg,
		Title:         appName + " Presence — settings",
		MinSize:       Size{Width: 460, Height: 230},
		Layout:        VBox{},
		DefaultButton: &nextBtn,
		CancelButton:  &cancelBtn,
		Children: []Widget{
			// Página 1: servidor.
			Composite{
				AssignTo: &serverPage,
				Layout:   VBox{},
				Children: []Widget{
					Label{Text: "Step 1 of 2 · Rainy server address:"},
					LineEdit{AssignTo: &serverLE, Text: server},
					VSpacer{},
					Composite{
						Layout: HBox{},
						Children: []Widget{
							HSpacer{},
							PushButton{
								AssignTo: &nextBtn,
								Text:     "Next",
								OnClicked: func() {
									srv := normalizeServer(serverLE.Text())
									if srv == "" {
										_ = msg.SetText("Enter the server address.")
										return
									}
									nextBtn.SetEnabled(false)
									_ = msg.SetText("Checking the server…")
									go func() {
										err := NewConnectClient(srv, "").CheckServer()
										a.mw.Synchronize(func() {
											nextBtn.SetEnabled(true)
											if err != nil {
												_ = msg.SetText(err.Error())
												return
											}
											chosen = srv
											_ = serverLabel.SetText("Step 2 of 2 · Server: " + srv)
											serverPage.SetVisible(false)
											accountPage.SetVisible(true)
											_ = dlg.SetDefaultButton(loginBtn)
											_ = msg.SetText(hintAccount)
											emailLE.SetFocus()
										})
									}()
								},
							},
						},
					},
				},
			},
			// Página 2: cuenta. Oculta hasta validar el servidor.
			Composite{
				AssignTo: &accountPage,
				Visible:  false,
				Layout:   VBox{},
				Children: []Widget{
					Label{AssignTo: &serverLabel, Text: "Step 2 of 2"},
					Label{Text: "Email:"},
					LineEdit{AssignTo: &emailLE},
					Label{Text: "Password:"},
					LineEdit{AssignTo: &passLE, PasswordMode: true},
					Composite{
						Layout: HBox{},
						Children: []Widget{
							PushButton{
								AssignTo: &backBtn,
								Text:     "Back",
								OnClicked: func() {
									accountPage.SetVisible(false)
									serverPage.SetVisible(true)
									_ = dlg.SetDefaultButton(nextBtn)
									_ = msg.SetText(hintServer)
									serverLE.SetFocus()
								},
							},
							HSpacer{},
							PushButton{
								AssignTo: &loginBtn,
								Text:     "Sign in",
								OnClicked: func() {
									email := strings.TrimSpace(emailLE.Text())
									password := passLE.Text()
									if email == "" || password == "" {
										_ = msg.SetText("Enter your email and password.")
										return
									}
									loginBtn.SetEnabled(false)
									backBtn.SetEnabled(false)
									go a.login(chosen, email, password, msg, func(ok bool) {
										loginBtn.SetEnabled(true)
										backBtn.SetEnabled(true)
										if ok {
											dlg.Accept()
										}
									})
								},
							},
						},
					},
				},
			},
			TextLabel{AssignTo: &msg, Text: hintServer},
			Composite{
				Layout: HBox{},
				Children: []Widget{
					HSpacer{},
					PushButton{
						AssignTo:  &cancelBtn,
						Text:      "Cancel",
						OnClicked: func() { dlg.Cancel() },
					},
				},
			},
		},
	}

	// Creamos la ventana sin dueño (si tuviera dueño, walk la centra respecto a la
	// ventana oculta y la muestra detrás), y la colocamos en el centro de la pantalla.
	if err := decl.Create(nil); err != nil {
		log.Printf("could not open settings: %v", err)
		return
	}
	// Show dimensiona la ventana según su contenido y conserva la posición; por eso
	// se centra después de mostrarla y antes del bucle de mensajes de Run.
	dlg.Show()
	centerWindow(dlg)
	dlg.Run()
}

// centerWindow coloca la ventana en el centro de la pantalla principal.
func centerWindow(w walk.Window) {
	b := w.BoundsPixels()
	sw := int(win.GetSystemMetrics(win.SM_CXSCREEN))
	sh := int(win.GetSystemMetrics(win.SM_CYSCREEN))
	_ = w.SetBoundsPixels(walk.Rectangle{
		X:      (sw - b.Width) / 2,
		Y:      (sh - b.Height) / 2,
		Width:  b.Width,
		Height: b.Height,
	})
}

// login hace el login y valida la sesión. Corre fuera del hilo de la UI;
// done se llama en el hilo de la UI con el resultado.
func (a *app) login(srv, email, password string, msg *walk.TextLabel, done func(ok bool)) {
	say := func(text string) {
		a.mw.Synchronize(func() { _ = msg.SetText(text) })
	}
	fail := func(err error) {
		a.mw.Synchronize(func() {
			_ = msg.SetText(err.Error())
			done(false)
		})
	}

	client := NewConnectClient(srv, "")
	say("Signing in…")
	token, username, err := client.Login(email, password)
	if err != nil {
		fail(err)
		return
	}

	say("Validating the session…")
	client.cookie = token
	if _, err := client.Me(); err != nil {
		fail(fmt.Errorf("sign-in worked, but the session could not be validated: %w", err))
		return
	}

	a.mw.Synchronize(func() {
		if err := a.adopt(client, token, srv); err != nil {
			_ = msg.SetText("Could not save the session: " + err.Error())
			done(false)
			return
		}
		a.setStatus("Connected as " + username)
		done(true)
	})
}

// adopt guarda la sesión y empieza a usarla. Se llama desde la UI tras un login correcto.
func (a *app) adopt(client *ConnectClient, token, server string) error {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	a.cfg.Server = server
	if err := a.cfg.setSessionToken(token); err != nil {
		return err
	}
	if err := saveConfig(a.cfg); err != nil {
		return err
	}
	client.cookie = token
	a.client = client
	return nil
}
