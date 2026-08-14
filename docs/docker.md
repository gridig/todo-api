# Docker Setup

This guide covers building, running, and deploying the Todo API in Docker containers.

## Prerequisites

- Docker Engine 24+
- Docker Compose v2

## Architecture

The Docker setup uses a two-stage build. TypeScript is compiled to JavaScript via `tsc` in the build stage; the runtime stage contains only compiled JS in `dist/`.

| Stage   | Base Image     | Purpose                                                                                   |
| ------- | -------------- | ----------------------------------------------------------------------------------------- |
| `build` | `node:24-slim` | Install all dependencies, generate Prisma client, compile TypeScript to `dist/` via `tsc` |
| runtime | `node:24-slim` | Production dependencies only, compiled JavaScript, Prisma schema and migrations           |

**Prisma generator configuration:** Prisma 7.x generates a TypeScript-first client with extensionless relative imports by default, which are incompatible with Node.js ESM after `tsc` compilation. The `schema.prisma` generator is configured with `importFileExtension = "js"` so the generated imports use `.js` extensions -- the standard TypeScript ESM convention that `tsc` preserves and Node.js resolves correctly at runtime.

**Why `node:24-slim` over Alpine?** The `bcrypt` native addon requires glibc. Alpine uses musl, which requires additional build tools. `slim` is the smallest glibc-based option.

## Quick Start

```bash
# Build the app image
docker compose build

# Start Postgres (wait for healthy)
docker compose up -d postgres

# Apply database migrations
docker compose run --rm -u root app npx prisma migrate deploy

# Start the full stack
docker compose up -d

# Verify
curl http://localhost:3001/health/ready
```

## Services

### Postgres (TimescaleDB + pgBackRest)

| Property     | Value                                                                      |
| ------------ | -------------------------------------------------------------------------- |
| Image        | Built from `docker/timescaledb/Dockerfile` (TimescaleDB pg16 + pgBackRest) |
| Container    | `todo-postgres`                                                            |
| Port         | `5432`                                                                     |
| User         | `postgres`                                                                 |
| Password     | `postgres`                                                                 |
| Database     | `todo_api`                                                                 |
| Volumes      | `postgres_data` (data), `pgbackrest_data` (POSIX backup repo)              |
| Health check | `pg_isready -U postgres` every 5s                                          |

The image co-locates pgBackRest with Postgres: the entrypoint writes `pgbackrest.conf` from env vars,
enables WAL archiving, and runs a background scheduler (daily full + 6h differential). Locally it uses a
POSIX repo on `pgbackrest_data`; in production an S3 (Railway Bucket) repo. The same image supports
restore via `PGBACKREST_RESTORE=1`. See [pgbackrest-implementation.md](pgbackrest-implementation.md) for
the build and [operations.md](operations.md#database-restore-disaster-recovery) for the restore runbook.

### Redis

| Property     | Value                     |
| ------------ | ------------------------- |
| Image        | `redis:7-alpine`          |
| Container    | `todo-redis`              |
| Port         | `6379`                    |
| Volume       | `redis_data` (persistent) |
| Health check | `redis-cli ping` every 5s |

Redis is provisioned for future use by the distributed rate limit store. The `REDIS_URL` environment variable is commented out in `docker-compose.yml` until the application code integrates it.

### App

| Property     | Value                                           |
| ------------ | ----------------------------------------------- |
| Image        | Built from `Dockerfile`                         |
| Container    | `todo-app`                                      |
| Port         | `3001`                                          |
| User         | `appuser` (non-root)                            |
| Health check | `GET /health/ready` every 10s, 30s start period |
| Depends on   | `postgres` (healthy), `redis` (healthy)         |

## Commands

### Building

```bash
# Build (or rebuild after code changes)
docker compose build

# Build with no cache (clean rebuild)
docker compose build --no-cache

# Build only the app service
docker compose build app
```

### Running

```bash
# Start everything (detached)
docker compose up -d

# Start only Postgres (for local development)
docker compose up -d postgres

# View logs (follow mode)
docker compose logs -f app

# View logs for all services
docker compose logs -f

# Check container status and health
docker compose ps
```

### Database Migrations

Migrations must be run separately from the app container. This is intentional -- coupling migrations into the entrypoint creates race conditions when scaling to multiple replicas.

The `-u root` flag is required because the app container runs as `appuser` (non-root), but Prisma needs write access to the engines directory inside `node_modules`. This is safe for one-off admin commands -- the app itself still runs as `appuser` during normal operation.

```bash
# Apply pending migrations
docker compose run --rm -u root app npx prisma migrate deploy

# Check migration status
docker compose run --rm -u root app npx prisma migrate status
```

In production, migrations should run as a CI/CD pipeline step (before deployment) rather than from the app container. The pipeline runner has full permissions and runs the migration exactly once, regardless of how many replicas are deployed.

### Stopping

```bash
# Stop all services (preserves volumes)
docker compose down

# Stop and remove volumes (destroys data)
docker compose down -v
```

### Debugging

```bash
# Shell into the running app container
docker compose exec app sh

# Shell into Postgres
docker compose exec postgres psql -U postgres -d todo_api

# Shell into Redis
docker compose exec redis redis-cli

# Inspect app container health
docker inspect --format='{{json .State.Health}}' todo-app | jq
```

## Environment Variables

The `app` service in `docker-compose.yml` sets environment variables directly. For production, use an env file instead:

```bash
docker compose --env-file .env.production up -d
```

### Required

| Variable       | Description                                  | Docker Compose Default                                        |
| -------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string                 | `postgresql://postgres:postgres@postgres:5432/todo_api`       |
| `JWT_SECRET`   | JWT signing secret (32+ chars in production) | `docker-compose-dev-secret-change-in-production-min-32-chars` |

### Optional

| Variable           | Description                                                    | Default                          |
| ------------------ | -------------------------------------------------------------- | -------------------------------- |
| `NODE_ENV`         | Environment (`development`, `production`, `test`)              | `production`                     |
| `PORT`             | Server port                                                    | `3001`                           |
| `LOG_LEVEL`        | Log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) | `info`                           |
| `CORS_ORIGIN`      | Allowed origins (comma-separated or `*`)                       | `*`                              |
| `CORS_CREDENTIALS` | Allow credentials in CORS                                      | `false`                          |
| `CORS_METHODS`     | Allowed HTTP methods                                           | `GET,HEAD,PUT,PATCH,POST,DELETE` |
| `CORS_HEADERS`     | Allowed request headers                                        | `Content-Type,Authorization`     |
| `CORS_MAX_AGE`     | Preflight cache duration (seconds)                             | `86400`                          |

**Important**: Inside the Docker network, `DATABASE_URL` must use the Postgres service name (`postgres`) as the host, not `localhost`. `localhost` inside a container refers to the container itself.

## Health Checks

The Dockerfile includes a `HEALTHCHECK` instruction. Docker automatically probes the container and reports status in `docker ps`:

```
CONTAINER ID   IMAGE          STATUS                   PORTS
abc123         todo-api-app   Up 2 min (healthy)       0.0.0.0:3001->3001/tcp
```

Two endpoints are available:

| Endpoint            | Purpose            | Returns                                                                                |
| ------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `GET /health`       | Liveness probe     | Always `200` if the process is alive                                                   |
| `GET /health/ready` | Readiness probe    | `200` when healthy, `503` when the database is unreachable or the DB pool is saturated |
| `GET /metrics`      | Prometheus metrics | `200` with process and application metrics in text exposition format                   |

For container orchestrators (Kubernetes, ECS):

- Configure the **liveness probe** to hit `/health`
- Configure the **readiness probe** to hit `/health/ready`

## Production Configuration

### Resource Limits

Add resource constraints to the `app` service in `docker-compose.yml`:

```yaml
app:
  # ... existing config ...
  deploy:
    resources:
      limits:
        cpus: '1.0'
        memory: 512M
      reservations:
        cpus: '0.25'
        memory: 128M
```

### Secrets

Never commit real secrets to `docker-compose.yml`. Options for production:

1. **Env file**: `docker compose --env-file .env.production up -d`
2. **Docker secrets** (Swarm mode): Mount secrets as files
3. **Orchestrator secrets**: ECS task definitions, Kubernetes Secrets, etc.

At minimum, `JWT_SECRET` and `DATABASE_URL` must use production values.

### Logging

Pino writes structured JSON to stdout in all environments. Docker captures stdout automatically, so all application logs are accessible via `docker compose logs`.

```bash
# Stream all app logs (live)
docker compose logs -f app

# Last 100 lines
docker compose logs --tail 100 app

# Search for errors
docker compose logs app | grep ERROR
```

For centralized logging, configure your orchestrator to ship stdout to your preferred sink (Grafana Loki, Datadog, CloudWatch, ELK, etc.).

### Networking

The `docker-compose.yml` exposes port `3001` to the host. In production behind a reverse proxy (nginx, Caddy, ALB), remove the port mapping and let the proxy reach the container over the Docker network:

```yaml
app:
  # Remove or comment out:
  # ports:
  #   - '3001:3001'
```

## Image Size and Startup Time

These are benchmark metrics required by the fair comparison spec.

### Measure Image Size

```bash
docker images --filter "reference=*todo*app*" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
```

### Measure Container Startup Time

```bash
# Ensure Postgres is up and migrations are applied
docker compose up -d postgres
docker compose run --rm -u root app npx prisma migrate deploy

# Stop app if running
docker compose stop app

# Measure time to first healthy response
START=$(date +%s%N)
docker compose up -d app
until curl -sf http://localhost:3001/health/ready > /dev/null 2>&1; do
  sleep 0.1
done
END=$(date +%s%N)
echo "Container startup: $(( (END - START) / 1000000 ))ms"
```

Run 5 times and take the median. This measures Docker container creation + Node.js boot + Prisma initialization + first successful database health check.

### Current Baselines (Apple Silicon / Docker Desktop)

| Metric                               | Value   |
| ------------------------------------ | ------- |
| Container startup time (median of 5) | 1,207ms |
| Image size                           | 512MB   |

## Dockerfile Walkthrough

### Build Stage

1. Start from `node:24-slim`, install OpenSSL (Prisma dependency)
2. Copy `package.json` and `pnpm-lock.yaml`, install all dependencies (cached unless deps change)
3. Copy Prisma schema, generate the Prisma client with a dummy `DATABASE_URL` (Prisma config validates the variable exists but `prisma generate` never connects to the database)
4. Copy TypeScript source files, run `tsc` to compile everything (including Prisma generated code) to `dist/`

### Runtime Stage

1. Start from a fresh `node:24-slim`, install OpenSSL
2. Create non-root `appuser` with a home directory (`--create-home`) so `npx`/`npm` can write cache files when running commands like `prisma migrate deploy`
3. Copy `package.json` and `pnpm-lock.yaml`, install production dependencies only
4. Copy Prisma schema, migrations, and config (needed for `prisma migrate deploy`)
5. Copy compiled `dist/` from build stage
6. Switch to `appuser`, expose port, configure health check, set `CMD`

The build stage is discarded. The final image contains production dependencies and compiled JavaScript in `dist/`. No TypeScript source, no dev dependencies, no test files.

## .dockerignore

The `.dockerignore` file prevents unnecessary files from being sent to the Docker build context:

- `node_modules` -- reinstalled inside the container
- `dist` -- compiled output is built inside Docker, not copied from host
- `.env`, `.env.*` -- secrets must not be baked into images
- `.git` -- repository history is not needed at runtime
- `__tests__`, `*.test.ts`, `jest.config.ts` -- test infrastructure
- `*.md`, `plans` -- documentation and planning files
- `coverage`, `logs` -- generated artifacts

## Troubleshooting

### App fails to connect to Postgres

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

`DATABASE_URL` is pointing to `localhost`. Inside Docker, use the service name `postgres` as the host:

```
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/todo_api
```

### Prisma generate fails during build -- missing DATABASE_URL

```
PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.
```

`prisma.config.ts` calls `env('DATABASE_URL')` which throws if the variable is missing. During `docker build`, no runtime environment variables are available and `.env` is excluded by `.dockerignore`. The Dockerfile handles this by providing a dummy value inline:

```dockerfile
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate
```

`prisma generate` only reads the schema to produce the client code -- it never connects to the database. The real `DATABASE_URL` is injected at runtime via `docker-compose.yml`.

### Prisma generate fails during build -- missing OpenSSL

```
Error: OpenSSL not found
```

The Dockerfile installs OpenSSL with `apt-get install -y openssl`. If you're using a custom base image, ensure OpenSSL is available.

### Health check fails

```
CONTAINER ID   IMAGE          STATUS                     PORTS
abc123         todo-api-app   Up 30s (health: starting)  0.0.0.0:3001->3001/tcp
```

The `--start-period=10s` gives the app time to boot. If it stays in `health: starting` for more than 30 seconds:

1. Check app logs: `docker compose logs app`
2. Verify Postgres is healthy: `docker compose ps postgres`
3. Verify migrations have been applied: `docker compose run --rm -u root app npx prisma migrate status`

### Permission denied errors

The runtime container runs as `appuser` (non-root). If you mount a volume that requires root access, either:

- Change the volume permissions on the host
- Remove the `USER appuser` line from the Dockerfile (not recommended for production)

### Build is slow

The Dockerfile is structured for optimal layer caching. If builds are slow:

- Ensure `package.json` and `pnpm-lock.yaml` haven't changed (dependency layer is cached)
- Use `docker compose build` instead of `docker compose up --build` for explicit build control
- Use BuildKit: `DOCKER_BUILDKIT=1 docker compose build`
