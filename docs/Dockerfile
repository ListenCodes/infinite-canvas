FROM oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e AS docs-build

WORKDIR /app
COPY docs/package.json docs/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --ignore-scripts --cache-dir=/root/.bun/install/cache
COPY docs ./
COPY CHANGELOG.md /CHANGELOG.md
RUN bun run postinstall
RUN bun run build

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=docs-build --chown=nextjs:nodejs /app/public ./public
COPY --from=docs-build --chown=nextjs:nodejs /app/index.md ./index.md
COPY --from=docs-build --chown=nextjs:nodejs /app/content ./content
COPY --from=docs-build --chown=nextjs:nodejs /app/.source ./.source
COPY --from=docs-build --chown=nextjs:nodejs /app/source.config.ts ./source.config.ts
COPY --from=docs-build --chown=nextjs:nodejs /CHANGELOG.md /CHANGELOG.md
COPY --from=docs-build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=docs-build --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
