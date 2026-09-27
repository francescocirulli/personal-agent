# Contributing to Personal Agent

Everyone may propose improvements by opening a **pull request against `main`**. You do not need write access: fork the repository, create a branch in your fork, and submit your PR. Keep each contribution focused on one problem and discuss large changes in an issue first.

## Review and ownership

**@francescocirulli is the sole maintainer and code owner for every file**, including the ownership and contribution rules. Only the maintainer can authorize acceptance and merge a contribution. External pull requests require that account's code-owner approval; other reviews and comments cannot replace it. New commits invalidate earlier approvals so the final changes can be reviewed.

The owner retains administrative control over repository settings and can maintain their own changes. GitHub does not allow authors to approve their own pull requests; do not add another code owner merely to work around this restriction. Branch protections are repository settings, while [.github/CODEOWNERS](.github/CODEOWNERS) defines ownership. Forking the repository does not grant upstream permissions. See GitHub's [code-owner documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

## Development setup

Use Node.js **22.13 or newer** (the Docker image uses Node 22), npm, Git, and a POSIX shell on Linux or macOS. Native packages may need Python 3, make, and a C/C++ compiler. On Windows, use WSL2 or a Linux development container; native Windows execution is not a documented setup.

```sh
git clone https://github.com/YOUR-USERNAME/personal-agent.git
cd personal-agent
git remote add upstream https://github.com/francescocirulli/personal-agent.git
git fetch upstream
git switch -c docs/your-change upstream/main
npm ci
cp .env.example .env
```

Set `DEMO_MODE=true` in your local `.env` for development without real agent subscriptions or paid audio requests, then run:

```sh
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to the backend at `127.0.0.1:4310`. Keep `APP_ORIGIN=http://localhost:5173` and `AGENT_UNRESTRICTED=false` for this setup. An empty password is suitable only for a private loopback development server. Demo mode is visibly labeled and does not prove that a real CLI or external integration works.

To run the compiled frontend locally:

```sh
npm run build
APP_ORIGIN=http://localhost:4310 npm start
```

Open `http://localhost:4310`. The backend runs via `tsx`; `build` type-checks the project and produces the frontend `dist/` directory.

For real agents on the host, install CLI versions compatible with the Dockerfile, authenticate them, and set `DEMO_MODE=false`. The runner inherits the host home unless configured otherwise; if setting `AGENT_CODEX_HOME`, authenticate Codex using that same directory. Keep real credentials out of test fixtures. The [self-hosting guide](README.md#docker-self-hosting) explains the equivalent container setup.

## Checks

Install dependencies once with `npm ci`. Use the checks relevant to your change:

```sh
npm run check
```

This runs TypeScript checking, the frontend production build, and backend tests. Backend tests use temporary data, local Git repositories, and fake agent CLIs; they do not validate real subscription accounts.

For UI changes, build first and install the test browsers and their system dependencies:

```sh
npm run build
npx playwright install --with-deps chromium webkit
npm run test:e2e
```

The browser suite runs Chromium and WebKit with a mobile viewport. Its config starts a demo server on port 4311 using `.data/e2e`; keep that port free. Linux browser dependency installation can require administrative privileges. Mobile emulation does not replace testing microphone permissions, installed PWA behavior, or push delivery on a physical phone.

For changes to the built-in browser/MCP integration:

```sh
npx playwright install --with-deps --only-shell chromium
npm run test:browser-engine
```

This uses real Chromium and a local fixture site without external accounts. When a Linux container cannot provide Chromium sandbox support, run this integration test with `BROWSER_NO_SANDBOX=true` inside that dedicated container only.

For focused checks, use the existing test files, for example:

```sh
node --import tsx --test tests/git.test.ts
npm run test:e2e -- tests/browser/branches.spec.ts --project=chromium
```

Format only the files you changed with the installed Prettier, for example `npx prettier --write README.md`. `npm run format` rewrites a broad set of project files; avoid unrelated formatting churn. Documentation-only changes need link/example/format review, not new tests that merely repeat their text.

`scripts/smoke-live.ts` and `scripts/smoke-skills.ts` are **opt-in live checks**. They use actual subscriptions; the audio smoke also incurs API charges and creates chats. Do not run them as ordinary tests or from untrusted PR automation. State explicitly in your PR if you ran a live check and what it verified, without including credentials.

## Code and documentation conventions

- Use TypeScript and the existing React/Express patterns. Follow `.prettierrc.json` (single quotes, 100-column width, trailing commas).
- Keep Markdown documentation in English. The current application UI and voice instructions are Italian; do not silently change product language as part of another fix.
- Add dependencies only when justified; update `package-lock.json` together with `package.json`.
- Add meaningful regression coverage for behavior changes, especially persistence, authorization, queue ordering, process cancellation, and cross-chat isolation.
- Keep database changes compatible with existing volumes and restart behavior. Never assume an empty database in production.
- Preserve accessible controls, keyboard focus, mobile readability, and layouts at narrow widths (320 and 390 pixels).
- Update the README when changing setup, configuration, commands, persistence, or operational requirements; update the architecture notes for structural changes.

## Submit a pull request

1. Commit your focused changes on a branch in your fork.
2. Run the applicable checks and review `git diff --check` and your complete diff.
3. Push your branch to your fork and open a PR with **base repository `francescocirulli/personal-agent`, base branch `main`**.
4. Explain the problem, resulting behavior, relevant issue, and validation. Add screenshots for visible UI changes, and document migrations or deployment steps when necessary.
5. Wait for @francescocirulli to review. Address feedback on the same branch; updated commits require renewed approval. The maintainer decides when and whether to merge.

Do not submit secrets, `.env`, runtime databases, browser cookies, CLI login files, private repository contents, generated builds, or test artifacts. Public issues and PRs are unsuitable for sensitive reports. For a suspected security vulnerability, use GitHub's private vulnerability reporting option if available; otherwise arrange a private channel with the maintainer before sharing exploit details.

Report the checks you actually ran, including failures and environmental limitations. Do not describe a simulated response as a live provider verification or claim physical-device coverage from browser tests.
