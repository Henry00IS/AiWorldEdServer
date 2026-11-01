# AiWorldEd collaborative editing relay.
#   docker build -t aiworlded-relay . && docker run --rm -p 8081:8081 aiworlded-relay
# Settings are environment variables (docs/SELF_HOSTING.md). The Bun version is pinned to
# the one in package.json "packageManager"; change both together.
FROM oven/bun:1.4.4-slim

WORKDIR /app
ENV NODE_ENV=production

# No runtime dependencies: only the lockfile metadata and the sources are copied.
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src

USER bun
EXPOSE 8081
ENV HOST=0.0.0.0 PORT=8081

# Follows PORT and TLS_CERT, so the check keeps working when either is changed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const s = process.env.TLS_CERT ? 'https' : 'http'; fetch(s + '://127.0.0.1:' + (process.env.PORT || 8081) + '/healthz', { tls: { rejectUnauthorized: false } }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["bun", "src/main.ts"]
