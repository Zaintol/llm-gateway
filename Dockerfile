# syntax=docker/dockerfile:1.7
# One multi-stage build for every Node service. Pick a service with --target (gateway, mock-provider).

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/schema/package.json packages/schema/
COPY packages/gateway/package.json packages/gateway/
COPY packages/mock-provider/package.json packages/mock-provider/
COPY packages/dashboard/package.json packages/dashboard/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
RUN pnpm -r build \
 && pnpm --filter @gw/gateway deploy --prod --legacy /out/gateway \
 && pnpm --filter @gw/mock-provider deploy --prod --legacy /out/mock-provider

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS gateway
COPY --from=build --chown=node:node /out/gateway .
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]

FROM runtime AS mock-provider
COPY --from=build --chown=node:node /out/mock-provider .
EXPOSE 4000
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
