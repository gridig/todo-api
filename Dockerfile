# Reproducibility: pin both stages to a sha256 digest. Resolve the current
# digest with:  docker pull node:24-slim && \
#               docker inspect --format='{{index .RepoDigests 0}}' node:24-slim
# Then replace both `FROM node:24-slim` lines below with the same
# `FROM node:24-slim@sha256:<digest>` form (one digest, both stages — cache reuse).
# Dependabot's `docker` ecosystem tracks digest pins.
# Pinned to Node 24: Prisma 7.x supports 20.19+/22.12+/24.0+ (not 26); see AGENTS.md.
FROM node:24-slim AS build

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@9.15.4 && pnpm install --frozen-lockfile

COPY prisma ./prisma
COPY prisma.config.ts ./
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

COPY tsconfig.json ./
COPY src ./src
# scripts/ holds preflight-roles.ts, compiled to dist/scripts/preflight-roles.js
# and invoked by railway.json's preDeployCommand. Must be present before tsc.
COPY scripts ./scripts

RUN npx tsc


FROM node:24-slim

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN groupadd --system appgroup && useradd --system --gid appgroup --create-home appuser

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@9.15.4 && pnpm install --frozen-lockfile --prod

COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/migrations ./prisma/migrations
COPY prisma.config.ts ./
COPY --from=build /app/prisma/generated ./prisma/generated
COPY --from=build /app/dist ./dist

RUN chown -R appuser:appgroup /app/node_modules/.pnpm/@prisma+engines@*

USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Migrations run as the Railway pre-deploy command (railway.json → deploy.preDeployCommand),
# not here — so a failed migration aborts the deploy and keeps the old version serving,
# instead of crash-looping the app container. The app's own boot gates (TimescaleDB +
# audit tamper-probe) still run in src/index.ts.
CMD ["node", "dist/src/index.js"]
