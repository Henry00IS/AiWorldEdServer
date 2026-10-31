# AiWorldEd collaborative editing relay.
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

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8081/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["bun", "src/main.ts"]
