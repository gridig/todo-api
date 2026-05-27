# Reproducibility: pin both stages to a sha256 digest. Resolve the current
# digest with:  docker pull node:26-slim && \
#               docker inspect --format='{{index .RepoDigests 0}}' node:26-slim
# Then replace both `FROM node:26-slim` lines below with the same
# `FROM node:26-slim@sha256:<digest>` form (one digest, both stages — cache reuse).
# Dependabot's `docker` ecosystem tracks digest pins.
FROM node:26-slim AS build

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@9.15.4 && pnpm install --frozen-lockfile

COPY prisma ./prisma
COPY prisma.config.ts ./
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

COPY tsconfig.json ./
COPY src ./src

RUN npx tsc


FROM node:26-slim

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

CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/src/index.js"]
