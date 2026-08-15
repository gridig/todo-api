# Reproducibility: both stages pinned to the same sha256 digest (one digest,
# both stages — cache reuse). Dependabot's `docker` ecosystem tracks the pin;
# bumps stay manual per AGENTS.md.
# Pinned to Node 24: Prisma 7.x supports 20.19+/22.12+/24.0+ (not 26); see AGENTS.md.
FROM node:24-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc AS build

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
COPY tsconfig.build.json ./

RUN npx tsc -p tsconfig.build.json


FROM node:24-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc

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

# Fail closed: this image only ever ships to deployed environments, so a
# missing/typo'd platform NODE_ENV must land in production mode (guardrails
# enforced: METRICS_TOKEN required, placeholder keys rejected, /echo off) —
# not silently fall into the development defaults.
ENV NODE_ENV=production

USER appuser

EXPOSE 3001

# Reads PORT rather than hardcoding 3001: the app binds env.PORT, so on any
# platform that injects its own PORT a fixed probe marks a healthy container
# unhealthy and restart-loops it. String concatenation, not a template literal —
# backticks inside this shell-form CMD would be command substitution.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||3001;fetch('http://localhost:'+p+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Migrations run as the Railway pre-deploy command (railway.json → deploy.preDeployCommand),
# not here — so a failed migration aborts the deploy and keeps the old version serving,
# instead of crash-looping the app container. The app's own boot gates (TimescaleDB +
# audit tamper-probe) still run in src/index.ts.
CMD ["node", "dist/src/index.js"]
