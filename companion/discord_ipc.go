//go:build windows

package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"
)

// Mismo application id que la app móvil (DiscordPresence.kt). Validado con
// el probe de scratchpad: Discord acepta la actividad con este id.
const discordClientID = "1558497086922690691"

// discordIPC habla con la app de escritorio de Discord por su named pipe.
// Trama: opcode (uint32 LE) + longitud (uint32 LE) + JSON.
type discordIPC struct {
	f *os.File
}

// openDiscord busca el pipe discord-ipc-0..9 y hace el handshake.
func openDiscord() (*discordIPC, error) {
	for i := 0; i < 10; i++ {
		f, err := os.OpenFile(fmt.Sprintf(`\\.\pipe\discord-ipc-%d`, i), os.O_RDWR, 0)
		if err != nil {
			continue
		}
		d := &discordIPC{f: f}
		if err := d.handshake(); err != nil {
			f.Close()
			return nil, err
		}
		return d, nil
	}
	return nil, errors.New("discord de escritorio no está abierto")
}

func (d *discordIPC) Close() {
	d.f.Close()
}

func (d *discordIPC) handshake() error {
	if err := d.send(0, map[string]any{"v": 1, "client_id": discordClientID}); err != nil {
		return err
	}
	msg, err := d.recv()
	if err != nil {
		return err
	}
	if msg["evt"] != "READY" {
		return fmt.Errorf("handshake: %v", msg["data"])
	}
	return nil
}

// SetActivity publica la actividad; nil la limpia.
func (d *discordIPC) SetActivity(a *discordActivity) error {
	nonce := strconv.FormatInt(time.Now().UnixNano(), 10)
	args := map[string]any{"pid": os.Getpid(), "activity": a}
	if err := d.send(1, map[string]any{"cmd": "SET_ACTIVITY", "args": args, "nonce": nonce}); err != nil {
		return err
	}
	// Discord puede intercalar eventos antes de la respuesta; leemos hasta encontrarla.
	for i := 0; i < 10; i++ {
		msg, err := d.recv()
		if err != nil {
			return err
		}
		if msg["cmd"] != "SET_ACTIVITY" {
			continue
		}
		if msg["evt"] == "ERROR" {
			return fmt.Errorf("discord: %v", msg["data"])
		}
		return nil
	}
	return errors.New("discord: sin respuesta a SET_ACTIVITY")
}

func (d *discordIPC) send(op uint32, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	buf := make([]byte, 8+len(data))
	binary.LittleEndian.PutUint32(buf[0:4], op)
	binary.LittleEndian.PutUint32(buf[4:8], uint32(len(data)))
	copy(buf[8:], data)
	_, err = d.f.Write(buf)
	return err
}

func (d *discordIPC) recv() (map[string]any, error) {
	var header [8]byte
	if _, err := io.ReadFull(d.f, header[:]); err != nil {
		return nil, err
	}
	body := make([]byte, binary.LittleEndian.Uint32(header[4:8]))
	if _, err := io.ReadFull(d.f, body); err != nil {
		return nil, err
	}
	var msg map[string]any
	if err := json.Unmarshal(body, &msg); err != nil {
		return nil, err
	}
	return msg, nil
}

// discordActivity es el payload de SET_ACTIVITY (nombres según la API de IPC).
type discordActivity struct {
	Type       int         `json:"type"`
	Details    string      `json:"details,omitempty"`
	State      string      `json:"state,omitempty"`
	Timestamps *timestamps `json:"timestamps,omitempty"`
	Assets     *assets     `json:"assets,omitempty"`
	Buttons    []button    `json:"buttons,omitempty"`
}

// Los timestamps van en segundos: el probe los vio devueltos como ms (×1000).
type timestamps struct {
	Start int64 `json:"start"`
	End   int64 `json:"end,omitempty"`
}

type assets struct {
	LargeImage string `json:"large_image"`
	LargeText  string `json:"large_text,omitempty"`
	SmallImage string `json:"small_image,omitempty"`
	SmallText  string `json:"small_text,omitempty"`
}

type button struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}
