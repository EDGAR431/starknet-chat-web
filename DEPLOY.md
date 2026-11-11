# Desplegar el cliente web en el VPS (starknet-chat.tech)

Servidor: `root@45.133.178.187`. Compose en `~/stoat`, servicio `web`, imagen local
`starknet-chat-web:local`. Carpeta de construccion: `~/stoat-for-web-0.16.0`
(no es un repo git: se actualiza con zips).

## 1. Subir el codigo (desde el PC)

Zip del repo (git archive de la rama a desplegar):

```bash
git archive --format=zip -o starknet-chat-web-XXXX.zip HEAD
```

```powershell
scp -i $env:USERPROFILE\.ssh\id_ed25519_stoat starknet-chat-web-XXXX.zip root@45.133.178.187:/root/
```

## 2. Construir y desplegar (en el VPS)

```bash
cd ~/stoat-for-web-0.16.0

# punto de retorno
docker tag starknet-chat-web:local starknet-chat-web:antes-$(date +%Y%m%d-%H%M)

# sobrescribir con el zip nuevo
unzip -o ~/starknet-chat-web-XXXX.zip -d ~/stoat-for-web-0.16.0

# construir (~5 min) y recrear el contenedor
docker build -t starknet-chat-web:local .
cd ~/stoat && docker compose up -d --force-recreate web
docker compose logs --tail 5 web
```

Aviso: `unzip -o` no borra archivos que ya no existen en el zip. Si se elimino algun
archivo en el codigo, borrarlo tambien a mano en `~/stoat-for-web-0.16.0` (o descomprimir
en una carpeta limpia).

## 3. Comprobar

- Abrir https://starknet-chat.tech con recarga forzada (Ctrl+F5).
- `https://starknet-chat.tech/rnnoise/rnnoise.wasm` debe descargar el archivo (no 404).

## 4. Volver atras

```bash
docker images starknet-chat-web          # elegir el tag "antes-..."
docker tag starknet-chat-web:antes-YYYYMMDD-HHMM starknet-chat-web:local
cd ~/stoat && docker compose up -d --force-recreate web
```

## Orden cuando cambian backend y web a la vez

Primero el backend (ver DEPLOY.md del repo starknet-chat-backend), despues la web.
