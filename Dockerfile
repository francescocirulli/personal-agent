FROM node:22-bookworm-slim
ARG CLAUDE_VERSION=2.1.280
ARG CODEX_VERSION=0.156.1
RUN apt-get update && apt-get install -y --no-install-recommends git gh python3 make g++ gosu ca-certificates openssh-client tini && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION} @openai/codex@${CODEX_VERSION}
WORKDIR /app
COPY package*.json ./
COPY scripts/prepare-pty.mjs ./scripts/prepare-pty.mjs
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npm ci && npx playwright install --with-deps --only-shell chromium && rm -rf /var/lib/apt/lists/*
ENV BROWSER_NO_SANDBOX=true
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY public ./public
RUN npm run build
COPY scripts/container-start.sh /usr/local/bin/container-start
RUN chmod +x /usr/local/bin/container-start && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATA_DIR=/data HOME=/data/home AGENT_CODEX_HOME=/data/home/.codex AGENT_UNRESTRICTED=true
USER node
EXPOSE 4310
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/container-start"]
CMD ["npm", "start"]
