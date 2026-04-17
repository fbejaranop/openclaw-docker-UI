# docker-config

A small Dockerized OpenClaw setup that renders `openclaw.json` from environment variables at first start, then keeps both config and workspace in per-instance persistent folders.

## What is included

- `Dockerfile` to build an OpenClaw image
- `openclaw.template.json` with env-driven config
- `docker-entrypoint.sh` that renders the final config with `envsubst`
- `.env.example` with the variables you are expected to fill
- `docker-compose.yml` for local runs
- Slack-only channel wiring for a simpler first deployment
- Selectable container tools from the UI, including `git`, `sdkman`, `jq`, `ripgrep`, `fd`, `vim`, `tmux`, Python, build-essential, and Java
- Flexible SSH setup, either generated per container or copied from the host machine
- A local HTML launcher to create new container instances from a browser
- Optional model-provider selection, so you only configure the API providers you actually need
- Browser-saved Slack credential profiles with nicknames
- Dynamic Slack app manifest and setup instructions generated from the instance name

## Why this shape

Some OpenClaw settings are regular values, like model names and tokens. Others, like allowed Slack or Discord channels, live inside object keys. Rendering the config at startup lets you drive both values and IDs from environment variables.

## Quick start

### Manual path

1. Copy the example env file:

   ```bash
   cp .env.example .env
   ```

2. Fill in the values you actually want.

3. Create the persistent directories for config and workspace:

   ```bash
   mkdir -p persistent/openclaw-home persistent/workspace
   ```

4. Build and run:

   ```bash
   docker compose up --build
   ```

### Browser UI path

1. Start the local launcher UI:

   ```bash
   node ui-server.js
   ```

2. Open:

   ```text
   http://127.0.0.1:3080
   ```

3. Fill the form, choose only the model providers you need, choose the container tools you want baked into the image, choose the SSH mode, optionally reuse a saved Slack profile, and press **Create container**.
4. If Slack is enabled, the UI shows a generated manifest preview based on the instance name and returns the exact manifest plus setup instructions after creation.

The UI writes an instance-specific `.env` and `docker-compose.yml` under `instances/<name>/`, creates `persistent/openclaw-home/` and `persistent/workspace/`, then runs Docker Compose for that instance.

If the project lives under a hidden path like `~/.openclaw/...` and your Docker comes from Snap, the launcher will default to `~/openclaw-docker-instances/` instead, because Snap-confined Docker often cannot read hidden directories under home.
You can also override the target directory explicitly with `UI_INSTANCES_DIR=/some/path node ui-server.js`.

## Main env vars

### Core

- `OPENCLAW_MODEL`
- `OPENCLAW_THINKING_DEFAULT`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

### Build tools

The browser launcher exposes built-in tool presets and an extra apt packages field. Under the hood it passes Docker build args so each instance image can be customized at creation time.

### SSH

- `OPENCLAW_SSH_MODE` (`generated` or `host`)
- `OPENCLAW_HOST_SSH_PATH` (used when `OPENCLAW_SSH_MODE=host`)

### Slack

- `SLACK_ENABLED`
- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_ALLOWED_CHANNEL_ID`

## Notes

- The rendered config is written to `/root/.openclaw/openclaw.json` inside the container, but only if it does not already exist.
- Each instance persists its data under `persistent/openclaw-home/` and `persistent/workspace/` inside that instance folder.
- The OpenClaw workspace is mounted at `/workspace`.
- The sample config is Slack-only and keeps Slack disabled until you explicitly enable it in `.env`.
- The sample gateway listens on port `18789` and binds to `all`, which is practical in Docker but means you should put it behind proper network controls.
- The image always includes the base runtime packages needed by OpenClaw, plus `openssh-client` for Git/SSH workflows.
- Additional tools like `git` and `sdkman` are selected in the launcher UI and baked into the image during `docker compose build`.
- You can also add extra Debian packages from the UI through the `Extra apt packages` field.
- On first container boot, the entrypoint either copies SSH files from the host mount or generates a fresh keypair at `/root/.ssh/id_ed25519` if one does not already exist.
- In host SSH mode, the launcher mounts your host SSH folder read-only and copies its contents into the instance so the originals are not modified by the container.
- The generated public key is printed to the logs when a new keypair is created, so you can add it as a deploy key to exactly one GitHub repo.
- If you want every new container instance to get a different key, keep using generated SSH mode.
- The launcher UI is intentionally local. It starts a small HTTP server on `127.0.0.1:3080` and shells out to Docker on your machine.
- Each launched instance gets its own folder under `instances/<name>/`.
- Manual edits to `openclaw.json` survive container restarts and machine reboots because the file lives in the instance's persistent host folder.
- If you already had an older instance using a Docker named volume, copy its data once into `persistent/openclaw-home/` before recreating the container, or the old config will stay stranded in the old volume.
- When Slack is enabled, the launcher also writes `slack-manifest.json` and `slack-setup.txt` into that instance folder.
