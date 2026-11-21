# StarknetChat — Web Client

The web client powering [starknet-chat.tech](https://starknet-chat.tech), built with [Solid.js](https://www.solidjs.com/).

This repository is a modified fork of Stoat's web client (AGPL-3.0). It is published here to comply with that license. Related repositories:

- Backend: https://github.com/EDGAR431/starknet-chat-backend
- Desktop app: https://github.com/EDGAR431/starknet-chat-desktop
- Android app: https://github.com/EDGAR431/starknet-chat-android

## Development Guide

Before getting started, you'll want to install:

- [Git](https://git-scm.com/install/)
- [mise-en-place](https://mise.jdx.dev/getting-started.html)

Then proceed to setup:

```bash
# clone the repository
git clone https://github.com/EDGAR431/starknet-chat-web client
cd client

# install all packages
mise install:frozen

# build deps:
mise build:deps

# or build a specific dep (e.g. stoat.js updates):
# pnpm --filter stoat.js run build

# customise the .env
cp packages/client/.env.example packages/client/.env

# run dev server
mise dev

# run all CI checks locally
mise check
```

### Connecting to a backend

By default, the client connects to a backend running on the same host (localhost). To point it at a different instance, edit `packages/client/.env` and set `VITE_API_URL` to that instance's API URL.

## Deployment Guide

### Build the app

```bash
# install packages
mise install:frozen

# build dependencies
mise build:deps

# build for web
mise build

# ... when building for production
mise build:prod
```

You can now deploy the directory `packages/client/dist`.

### Routing Information

The app currently needs the following routes:

- `/login`
- `/pwa`
- `/dev`
- `/discover`
- `/settings`
- `/invite`
- `/bot`
- `/friends`
- `/server`
- `/channel`

This corresponds to [Content.tsx#L33](packages/client/src/index.tsx).

## License

AGPL-3.0 — see [LICENSE](./LICENSE).
