# Rainy Presence

Companion de escritorio (Windows) que muestra en tu perfil de Discord lo que suena en Rainy. Lee el estado de reproducción de Rainy Connect (el mismo que usa el control entre dispositivos) y lo publica en la app de Discord de escritorio abierta en este PC.

## Requisitos

- Windows 10/11 con la app de Discord de escritorio abierta.
- Go 1.26+ para compilar.

## Estado: etapa 2 (publicación en Discord)

El companion lee cada 3 s qué dispositivo de tu cuenta está reproduciendo (Rainy Connect) y lo publica en Discord. Para que aparezca algo hace falta:

- La app de escritorio de Discord abierta en este PC.
- Una canción sonando en Rainy desde algún dispositivo de tu cuenta (web o móvil).

Si pausas o cierras la reproducción, la actividad desaparece. Si Discord rechaza la URL de la portada, se publica con el logo.

## Primer arranque

Al arrancar sin servidor ni sesión se abre la configuración en dos pasos:

1. **Servidor**: escribes la dirección y pulsas **Siguiente**. Se comprueba que es un servidor Rainy antes de seguir.
2. **Cuenta**: aparecen el email y la contraseña. **Entrar** hace el login y valida la sesión. **Atrás** vuelve al paso 1.

El login usa el email, porque es lo que pide el endpoint de Rainy.

- La contraseña no se guarda. La sesión se guarda cifrada con DPAPI (tu cuenta de Windows) en `%APPDATA%\RainyPresence\config.json`.
- Servidor local: `192.168.1.10:5000` (se usa `http://`, y el programa avisa en el log).
- Servidor con dominio: `tu-dominio.com` (se usa `https://`).

Se puede preseleccionar un servidor con `-server`, por ejemplo `go run . -server 192.168.1.10:5000`.

## Uso diario

Compila sin consola para que no aparezca una ventana negra:

```bash
go build -ldflags "-H windowsgui" -o rainy-presence.exe .
```

El icono de la bandeja muestra el estado. Su menú tiene:

- Estado actual (lo que suena o por qué no publica).
- **Pausar / reanudar publicación**.
- **Configurar…**: cambiar servidor o cuenta.
- **Salir**: quita la actividad de Discord antes de cerrar.

El registro se escribe en `%APPDATA%\RainyPresence\presence.log`.

## Pruebas

```bash
go test ./...
RAINY_LIVE=1 go test -run TestLiveITunesCover ./...   # consulta real a iTunes
```

## Estructura

- `main.go`: arranque, log y normalización de la URL del servidor.
- `ui.go`: bandeja, menú y ventana de configuración (walk).
- `app.go`: bucle que lee Connect y publica en Discord.
- `connect_client.go`: login y lectura de dispositivos.
- `discord_ipc.go`: named pipe de Discord (solo Windows).
- `presence.go`: qué dispositivo suena, antirrebote y tolerancia de seek.
- `cover.go`: portada pública vía iTunes.
- `config.go`, `secret_windows.go`: configuración y cifrado DPAPI.
- `app.manifest`, `rsrc_windows_amd64.syso`: manifiesto de Windows e icono del `.exe`, necesarios para la interfaz. Se regeneran con `rsrc -manifest app.manifest -ico assets/icon.ico -o rsrc_windows_amd64.syso`.

## Limitaciones conocidas

- Solo Windows (IPC por named pipe).
- Si la sesión caduca, se abre la configuración de nuevo desde el menú.
- Publica el dispositivo que suena más recientemente, sea web o móvil.
