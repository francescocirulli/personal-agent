# Personal Agent

A self-hosted, single-user web app for working with **Claude Code and Codex from your phone or desktop**. Chat with your agents, give them access to your repositories, and follow their work even after you close the browser. Install the PWA on your home screen for quick access.

The backend runs the official agent CLIs with your own subscription logins. Optional speech transcription and synthesis use a separate OpenRouter account. The interface and default agent instructions currently use Italian; this documentation is in English. There is no language selector yet.

## Features

- Persistent conversations, resumable CLI sessions, per-chat model and reasoning effort.
- Background tasks, message queues, cancellation, conversation forks, and searchable history.
- GitHub repository selection, independent checkouts per chat, branch switching, and readable diffs.
- Voice input and playback, optional Web Push notifications, and mobile-friendly Markdown.
- Image and document attachments, downloadable generated files, and local drafts.
- Remote MCP connections with browser-based OAuth, global skills with per-chat selection, and a built-in Chromium browser.
- An authenticated terminal for managing tools inside your instance.

## Choose a setup

- **Your own server:** follow [Docker self-hosting](#docker-self-hosting).
- **Local development or a demo:** see [CONTRIBUTING.md](CONTRIBUTING.md).
- **Internals:** see [ARCHITECTURE.md](ARCHITECTURE.md).
- **Coding-agent instructions:** see [AGENTS.md](AGENTS.md).

## Docker self-hosting

### 1. Requirements

Use a dedicated Linux server or VM with Git, Docker Engine, and the Docker Compose plugin ([Compose 2.24 or newer](https://docs.docker.com/reference/compose-file/services/#required) for the supplied `env_file` configuration). The host must support the Node 22 base image, native dependencies, and Playwright Chromium; Linux x86-64 is a straightforward starting point. Windows users should use a Linux VM or Docker's Linux containers.

For an initial deployment, budget around 2 CPU cores, 4 GB RAM, and 10 GB free disk plus space for repositories, dependencies, attachments, and backups. This is a starting estimate, not a measured minimum. Large builds and concurrent browser/agent sessions need more resources; reduce `MAX_CONCURRENT_RUNS` on smaller hosts.

You also need:

- A domain pointing to the server and an HTTPS reverse proxy for remote use. The example below uses Caddy installed on the host.
- Outbound HTTPS access to the agent providers, package registries, and any GitHub/MCP services you use.
- A subscription login supported by at least one of the bundled CLIs. You do not need to configure both agents.
- An OpenRouter key only if you want real voice input or output.

This app gives its authenticated user access to a shell, repositories, and agent credentials. Run it as a personal instance for one trusted user. Separate chats are not security sandboxes. Do not mount the Docker socket, your host home directory, or unrelated production secrets into the container.

### 2. Clone and configure

```sh
git clone https://github.com/francescocirulli/personal-agent.git
cd personal-agent
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Copy the generated password into `.env` using a local editor. For a server deployment, set at least:

```dotenv
APP_ORIGIN=https://agent.example.com
APP_PASSWORD=replace-with-your-generated-password
DEMO_MODE=false
MAX_CONCURRENT_RUNS=3
```

Replace the domain with your own. `APP_ORIGIN` is the exact external origin (scheme, host, and port if nonstandard), without a path or trailing slash. Deploy at the domain root, not under a URL subpath. Never commit `.env` or paste credentials into an issue or chat.

Compose sets `HOST=0.0.0.0`, `PORT=4310`, `DATA_DIR=/data`, and **`AGENT_UNRESTRICTED=true`**, overriding those entries in `.env`. This lets agents act autonomously inside the dedicated container. To change that behavior, edit the Compose `environment` setting; setting it to `false` only in `.env` is insufficient. The container runs the app and agents as the non-root `node` user.

### 3. Build and start

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail 50 app
curl --fail http://127.0.0.1:4310/healthz
```

The health endpoint should return `{"ok":true}`. It checks HTTP liveness, not agent logins or external services. The first build downloads Node dependencies, both agent CLIs, and Chromium; it needs internet access. CLI versions are pinned by the `CLAUDE_VERSION` and `CODEX_VERSION` build arguments in [Dockerfile](Dockerfile).

The supplied configuration publishes port 4310 **only on the host's loopback interface**. Keep it that way and put HTTPS in front of it. The app requires a password of at least 24 characters when listening on a non-loopback address, including inside Docker.

### 4. Add HTTPS

Install [Caddy using its official instructions](https://caddyserver.com/docs/install) on the same host. Point your domain's DNS to the server and allow incoming TCP ports 80 and 443. Add this site to `/etc/caddy/Caddyfile`:

```caddyfile
agent.example.com {
    reverse_proxy 127.0.0.1:4310
}
```

Validate and reload your host's Caddy service:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://agent.example.com/healthz
```

Caddy manages HTTPS certificates and streams server-sent events through its [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). If you use another proxy, preserve the original `Host` header, allow long-running SSE connections without buffering, support HTTP Range requests for audio, and allow request bodies large enough for attachments (four documents can total 80 MB). Do not cache `/api/*` responses. A proxy running in another container needs a shared Docker network; its `127.0.0.1` does not refer to the app container.

Open your HTTPS domain and sign in with `APP_PASSWORD`. On iPhone, open it in Safari and choose **Share → Add to Home Screen**. Microphone access and remote PWA features need a secure context. The server must stay running when the phone disconnects.

### 5. Authenticate your agents

Perform these steps yourself in your server terminal. Authentication belongs to your instance; never send tokens or device codes through chat. Consult the provider's current subscription eligibility and terms before use.

**Claude Code:** run the bundled token setup command and complete the browser flow:

```sh
docker compose exec app claude setup-token
```

Store the resulting token as `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, then recreate the app:

```sh
docker compose up -d --force-recreate app
```

**Codex:** log in using the bundled CLI's device flow:

```sh
docker compose exec -e CODEX_HOME=/data/home/.codex app codex login --device-auth
```

Complete the login in your browser. The explicit `CODEX_HOME` matches `AGENT_CODEX_HOME` used by the runner; authentication persists in the volume. The runner enforces ChatGPT subscription login. It does not use an `OPENAI_API_KEY` for coding tasks.

Create a chat with the configured agent and send a small text request. A successful health check or demo response does not verify a real agent login. Models available to your account depend on the provider and CLI version.

### 6. Connect GitHub (optional)

For repository browsing, cloning, and Git operations, authenticate the bundled GitHub CLI:

```sh
docker compose exec app gh auth login
docker compose exec app gh auth setup-git
docker compose exec app git config --global user.name "Your Name"
docker compose exec app git config --global user.email "you@example.com"
docker compose exec app gh auth status
```

Alternatively, set `GH_TOKEN` in `.env` with access limited to the repositories and operations you need, then recreate the container. The entrypoint configures Git's credential helper when `GH_TOKEN` is present. Without a token, run `gh auth setup-git` yourself as shown above. Git identity and stored CLI logins persist under `/data/home`.

Select a GitHub repository when creating a chat, or use a chat without a repository. Agents can modify and push to repositories according to your instructions and the credential's permissions.

### 7. Enable optional services

**Voice:** set `OPENROUTER_API_KEY` and recreate the container. Speech uses separately billed audio APIs; text-only agent use does not need this key. The defaults are `openai/gpt-4o-transcribe`, `google/gemini-3.8-flash-lite-tts`, and voice `Kore`. These are code defaults, not a guarantee of current provider availability. Choose supported models and a compatible voice in the app's voice settings. Saved settings override `.env` defaults until reset.

**Push notifications:** generate a key pair once:

```sh
docker compose exec app npm run keys:vapid
```

Store `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and a real `VAPID_SUBJECT` (for example, `mailto:you@example.com`) in `.env`, then recreate the container. Keep these keys stable across restarts and enable notifications in the app. Test delivery on your actual device; browser automation does not verify phone push delivery.

**MCP:** open the app's MCP settings, add a remote server URL, and complete any required login in the browser. The callback is `APP_ORIGIN/api/mcp/callback`. Supported connections use Streamable HTTP, either without authentication or with OAuth and dynamic client registration. Providers requiring other transports, static tokens, or pre-registered clients need additional integration. New tools become available on the next message in chats that include them. Do not paste OAuth callback URLs into a conversation; use the dedicated login panel if manual return is required.

**Skills:** manage global skill instructions in settings and select which agents and chats can use them. New chats inherit globally available MCP connections but start with global skills unselected. Repository skills remain available from their project directories.

## Configuration reference

Environment variables are read at server startup. Restart local development or recreate the container after changing them. Docker Compose reads dotenv quoting; do not assume `docker run --env-file .env` handles quotes the same way.

| Variable                                 | Default outside Docker                      | Purpose                                                                                       |
| ---------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `HOST` / `PORT`                          | `127.0.0.1` / `4310`                        | HTTP bind address and port; Compose overrides both.                                           |
| `DATA_DIR`                               | `.data`                                     | Persistent state; Compose uses `/data`.                                                       |
| `APP_ORIGIN`                             | `http://localhost:5173`                     | Browser-facing origin; use your HTTPS domain in production.                                   |
| `APP_PASSWORD`                           | Empty                                       | Empty disables login on local development; use a strong password for every server deployment. |
| `DEMO_MODE`                              | `false`                                     | Explicit simulated responses without agent subscription or paid audio calls.                  |
| `MAX_CONCURRENT_RUNS`                    | `3`                                         | Concurrent chat runs, from 1 to 16; one active run per chat.                                  |
| `AGENT_UNRESTRICTED`                     | `false`                                     | Bypass CLI permission/sandbox prompts; Compose sets `true`.                                   |
| `CLAUDE_BIN` / `CODEX_BIN`               | `claude` / `codex`                          | Executable names or paths.                                                                    |
| `CLAUDE_CODE_OAUTH_TOKEN`                | Empty                                       | Claude subscription token for the official CLI.                                               |
| `AGENT_CODEX_HOME`                       | Unset                                       | Dedicated Codex state directory; image uses `/data/home/.codex`.                              |
| `GH_TOKEN`                               | Unset                                       | Optional GitHub credential for repository operations.                                         |
| `OPENROUTER_API_KEY`                     | Empty                                       | Optional audio API credential.                                                                |
| `AUDIO_BASE_URL`                         | `https://openrouter.ai/api/v1`              | Audio API base URL.                                                                           |
| `STT_MODEL`                              | `openai/gpt-4o-transcribe`                  | Default transcription model.                                                                  |
| `TTS_MODEL` / `TTS_VOICE`                | `google/gemini-3.8-flash-lite-tts` / `Kore` | Default speech model and voice.                                                               |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Empty                                       | Optional persistent Web Push key pair.                                                        |
| `VAPID_SUBJECT`                          | `mailto:admin@example.com`                  | Replace with your operator contact; the example env uses `you@example.com`.                   |
| `BROWSER_NO_SANDBOX`                     | Unset                                       | Image sets `true` for container Chromium; leave unset in ordinary host development.           |

## Persistence, backups, and updates

The named Docker volume **`personal-agent-data`**, mounted at `/data`, holds SQLite (`agent.sqlite` and its WAL files), conversations and attachments, repository checkouts, audio, browser state/screenshots, MCP tokens, skills, installed tools, and CLI credentials. `/data/home` is the container home; `/data/tools` stores user-installed tools. The `.env` file stays on the host, outside the volume.

Use one running app instance per data volume. This is not a stateless service and does not support horizontal replicas sharing its SQLite state. Do not run `docker compose down -v` unless you intend to delete the data volume.

For a consistent backup, first finish or stop active work and pause queues in the UI, then stop the app. The following creates a private archive in a local `backups` directory:

```sh
mkdir -p backups
chmod 700 backups
docker compose stop app
docker compose run --rm --no-deps --user root --entrypoint sh \
  -v "$PWD/backups:/backup" app \
  -c 'umask 077; tar -czf /backup/personal-agent-data.tar.gz -C /data .'
docker compose start app
```

This overwrites an archive of the same name: rotate it before the next backup. Store `.env` separately in an encrypted backup and encrypt the volume archive before moving it off the server. Both contain sensitive credentials. Test recovery on a separate instance.

To restore on a fresh server, clone the app, restore `.env`, build the image with `docker compose build`, and put the archive in `backups/`. With no app running and a new empty destination volume:

```sh
docker compose run --rm --no-deps --user root --entrypoint sh \
  -v "$PWD/backups:/backup:ro" app \
  -c 'tar -xzf /backup/personal-agent-data.tar.gz -C /data'
docker compose up -d
```

Only restore archives you trust. Do not extract over a live or populated volume. The archive preserves numeric ownership; the supplied image uses the `node` user. Keep the same `/data` path. A new domain requires updating `APP_ORIGIN`, signing in again, and potentially reconnecting OAuth services and push notifications.

For updates, back up first, read the incoming changes, and use a clean deployment checkout:

```sh
git switch main
git pull --ff-only origin main
docker compose up -d --build
curl --fail http://127.0.0.1:4310/healthz
docker compose logs --tail 50 app
```

A restart interrupts active tasks; they are not automatically rerun. Pending queue messages can resume after startup unless paused. Verify a text request and any integrations you use after updating. For rollback, restore the matching code revision **and** its pre-update data backup if schema changes make the newer data incompatible.

For other container hosts, build the supplied Dockerfile, attach persistent storage at `/data`, set the same environment, expose port 4310 behind HTTPS, and configure `/healthz` as the liveness check. Keep one always-on replica. If the host mounts a root-owned volume, initialize ownership for `node`; the entrypoint supports starting as root solely to fix ownership before dropping privileges. Do not run the app itself as root.

## Troubleshooting and limitations

| Symptom                                 | What to check                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Container exits immediately             | Check logs and a 24+ character `APP_PASSWORD`; verify writable `/data`.                                    |
| Host/origin rejected (HTTP 403)         | Match `APP_ORIGIN` to the exact public URL; preserve `Host` through the proxy.                             |
| Login does not persist                  | Use HTTPS when `APP_ORIGIN` is HTTPS; secure cookies are not sent over ordinary HTTP.                      |
| Updates arrive late or connections drop | Disable proxy buffering/caching for SSE and increase idle timeouts.                                        |
| Agent executable or login fails         | Check bundled CLI versions, selected agent, subscription login, and Codex home path.                       |
| Audio fails                             | Check OpenRouter credentials, account balance, model availability, and saved voice settings.               |
| Chromium cannot launch                  | In Docker, rebuild the image and check memory; locally install the Playwright browser and OS dependencies. |
| Repository operations fail              | Check `gh auth status`, repository permissions, Git credential helper, and commit identity.                |
| Native dependency installation fails    | Use Node 22.13+ and install Python 3, make, and a C/C++ toolchain; Docker includes them.                   |
| Local changes block branch switching    | Commit or otherwise resolve them yourself; the app does not automatically stash or reset.                  |

The app is an early implementation. The server keeps tasks running while your phone is offline, but mobile browsers may suspend microphone capture and playback in the background. The built-in browser has its own cookies per chat and does not inherit the phone's logins. Persistent storage and shell access are shared within your instance; browser and environment filtering do not turn this into a multi-user security boundary.

Document extraction supports PDF, DOCX, XLSX, CSV, TXT, Markdown, and JSON, with four attachments per message and up to 20 MB per document. Extracts are limited to 100 PDF pages, 5,000 rows/100 columns per spreadsheet sheet, and 200,000 characters. There is no OCR. Agents also receive the originals. Generated downloads are limited to 10 files, 20 MB each and 80 MB total; export subdirectories and symlinks are excluded. Draft attachments live in the browser and are not synchronized across devices.

## Contributing

Everyone is welcome to fork the repository and **open a pull request targeting `main`**. Only **[@francescocirulli](https://github.com/francescocirulli)** can authorize acceptance of contributions. All files have that account as their sole code owner; external PRs require the owner's approval before merge. Community feedback is welcome and does not replace that approval.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the PR workflow. Third-party agent logos retain their owners' rights; see [brand attribution](public/brands/README.md).

## License status

A project license has not been selected yet. The maintainer will publish the license separately. Third-party dependencies and brand assets retain their own licenses and notices.
