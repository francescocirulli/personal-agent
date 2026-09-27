# Architecture

Personal Agent is a single-user application deployed as one Node process with a persistent data directory. The browser UI, official agent CLIs, and optional external integrations communicate through an authenticated Express backend. This document describes the implementation; installation and operations are in [README.md](README.md).

## Runtime overview

```text
Phone or desktop browser (React PWA)
            |
            | HTTPS: JSON, uploads, audio, downloads, SSE
            v
Reverse proxy -> Express backend -> SQLite + persistent files
                       |
                       +-> Claude Code / Codex child processes
                       |       +-> Git, GitHub CLI, project tools
                       |       +-> MCP gateway and embedded browser
                       +-> OpenRouter audio APIs (optional)
                       +-> Web Push delivery (optional)
```

Vite serves the UI during development and builds static assets into `dist/`. In production the backend serves those assets. The backend starts through `tsx`; Node's built-in SQLite support requires Node 22.13 or newer. Docker packages both official agent CLIs, native build tools, and Playwright Chromium Headless Shell.

## Main components

| Component                                                            | Responsibility                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/main.tsx` and UI components                                     | Conversations, settings, queues, voice, files, Git controls, work status.               |
| `src/api.ts`, `src/voice.ts`, `src/notifications.ts`                 | Browser/server communication, microphone/player lifecycle, notifications.               |
| `server/config.ts`                                                   | Environment defaults and startup validation.                                            |
| `server/app.ts`                                                      | HTTP authorization, routes, SSE, orchestration, concurrency, shutdown.                  |
| `server/store.ts`                                                    | SQLite schema/migrations, conversations, messages, runs, events, attachments, settings. |
| `server/runner.ts`                                                   | CLI arguments, filtered environment, resume, attachments, process cancellation.         |
| `server/protocol.ts`                                                 | Normalize CLI events into application messages and activity.                            |
| `server/git.ts`, `server/github.ts`, `server/git-diff.ts`            | Repository discovery, separate clones, branch operations, bounded diffs.                |
| `server/audio.ts`, `server/audio-settings.ts`                        | Transcription, speech, audio cache, persistent model/voice settings.                    |
| `server/mcp.ts`, `server/mcp-request.mjs`                            | Remote MCP OAuth, local grants/gateway, agent connection helper.                        |
| `server/skills.ts`, `server/chat-tools.ts`                           | Project/global skills, per-chat selection, effective availability.                      |
| `server/browser.ts`                                                  | Lazy Chromium process, per-chat contexts, browser MCP and screenshots.                  |
| `server/terminal.ts`, `server/tool-environment.ts`                   | Authenticated PTY shell and persistent user-installed tools.                            |
| `server/files.ts`, `server/images.ts`, `server/document-extract.mjs` | Upload validation, extraction, temporary files, generated downloads.                    |
| `server/notifications.ts`                                            | Optional Web Push notification delivery.                                                |

## Conversation and run lifecycle

Each conversation fixes its agent and optionally associates a GitHub repository. Model, effort, and tool selection can change for subsequent turns. A repository chat receives its own clone and initial branch; an unassociated chat receives an independent working directory. These are separate directories in one trusted user's runtime, not isolated security containers.

Messages and attachments are persisted before execution. There is one active run per chat and a configurable global run limit. Additional messages for an active chat enter a persistent queue. Queue pause, edit, reorder, removal, and immediate-send operations are coordinated with run state. Immediate send cancels the current run and waits for termination before starting the selected message.

The runner launches `claude -p` or `codex exec`, captures structured output, and saves the CLI session identifier for future resume. Public progress and tool activity are normalized for the UI. Events are persisted and replayed over SSE when a client reconnects. Closing the browser or an SSE connection does not stop work.

Cancellation terminates the process group and escalates after a grace period. At shutdown, new starts are blocked; after restart, previously active runs are marked interrupted instead of replaying actions. Pending messages can resume automatically unless their queue is paused.

An explicit final-response marker, `<richiesta_input/>`, records a real need for user input and pauses the queue. It is removed from visible text. A direct user reply takes priority; remaining queued messages stay paused until resumed. A completed process indicates protocol completion, not independently verified task correctness.

Forking a conversation copies history and attachments up to the selected response, agent/model/effort, repository, and tool selection. It does not copy the CLI session, browser session, queue, or uncommitted workspace state. The new chat gets its own workspace and seeds a new CLI session from the copied history.

## Storage and operations

`DATA_DIR` contains `agent.sqlite` (WAL mode), workspaces, audio, browser state/screenshots, tool connection state, and temporary run files. In Docker it is `/data`, with the CLI home at `/data/home` and installed tools at `/data/tools`. Attachments and conversation state persist in SQLite; OAuth state and tokens also live in private MCP files. Back up the entire volume and the separate deployment environment, not just the main SQLite file.

Keep a single running instance per data directory. The process coordinates queues, browser contexts, and subprocesses in memory; sharing SQLite across independent replicas does not provide distributed coordination. Schema initialization includes migrations for existing data. Changes must preserve upgrades and recovery from interrupted work.

Deleting a conversation removes its conversation records and owned attachments; shared audio and repository checkout files can remain. Browser-local drafts use localStorage/IndexedDB and are not part of server backups.

## Authentication and trust

The single-user login uses a password and a persisted hashed session token. Cookies are HttpOnly and SameSite Strict, and use Secure when the configured public origin is HTTPS. Host/Origin checks and login rate limits complement session checks. The public `/healthz` endpoint returns liveness without application data.

The Docker app runs as a non-root user, but the supplied Compose configuration enables unrestricted agent execution. The authenticated terminal and agents can access the instance's shared filesystem and credentials. The process environment passed to agents is filtered to avoid automatically exposing the app password, audio key, or unrelated model API keys; that filtering is not a filesystem isolation boundary.

Secrets, provider authentication, MCP callbacks, and browser cookies must not be logged into public activity or committed. Upload and download routes verify ownership and path containment. Active file types are served as downloads. Git diffs avoid external converters, ignored files, and symlink target reads.

## MCP, skills, and browser

App-managed MCP connections are global, with per-chat selection. OAuth uses discovery, dynamic registration where supported, PKCE, and one-time callback state; the callback does not depend on the app's strict same-site cookie. Tokens are stored privately on the server. CLI tools receive local gateway endpoints protected by temporary grants limited to the current run and selected connections. Global disablement blocks subsequent calls even with an existing grant.

Global skills are stored as Markdown instructions and assigned to selected agents. A turn receives a snapshot of available skills and their file locations. New chats inherit global MCP availability but start with global skills unselected. Project skill discovery covers the supported repository skill directories for both agents. Native CLI configuration remains outside the app-managed selection system.

The built-in `personal_agent_browser` MCP server controls Playwright. Chromium starts only when needed. Contexts are separated by chat, bounded by the configured capacity, and closed after inactivity or on cancellation/shutdown. Cookies and local storage can persist; open pages are recreated after restart. The phone's browser login is separate.

The browser rejects non-HTTP(S) navigation, the app/control endpoints, and known metadata destinations while allowing project previews on other local ports. This is not full network isolation. Docker disables Chromium's internal sandbox through `BROWSER_NO_SANDBOX`; ordinary host development should keep the sandbox enabled.

## Audio, files, and frontend state

Voice follows transcription → agent → speech. Coding-agent inference stays in the official CLI, while audio uses the separately configured provider. The `<voce>` section supplies spoken text without reading code and URLs. TTS is cached by text/model/voice; Gemini PCM output is wrapped as playable WAV. One global player controls playback, and late HTTP responses must not switch the active speaking chat. Technical progress remains textual; notifications open a conversation without autoplay.

Document extraction runs in a separate process with time and heap limits. Extracts are bounded and do not perform OCR; original files remain available. Turn export directories accept only direct regular files within count/size limits. Temporary attachment/extraction files are cleaned up after execution; abrupt process termination can leave files for later operational cleanup.

The frontend must preserve mobile accessibility, scroll/focus behavior, queue state, and local drafts. Git panels show local changes or comparison with a selected base, not an atomic snapshot of a running task. Branch operations require a clean workspace and no active/queued task. Manual terminal commands remain outside that coordination.

## Validation boundaries

Backend tests use fake CLIs, temporary databases, and local Git remotes. Playwright UI tests use the explicit demo mode on Chromium/WebKit. Browser-engine integration tests run real Chromium against a local fixture. These validate application behavior without proving current provider compatibility, subscription access, production proxy configuration, or physical-device microphone/push behavior. Live checks are opt-in and reported separately; see [CONTRIBUTING.md](CONTRIBUTING.md#checks).
