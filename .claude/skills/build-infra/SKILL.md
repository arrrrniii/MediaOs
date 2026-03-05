---
name: build-infra
description: Build MediaVault Track 1 — Infrastructure & Database. Docker Compose, Dockerfiles, env config, PostgreSQL migrations, and worker scaffold.
disable-model-invocation: true
context: fork
---

# Track 1: Infrastructure & Database

Read `info.md` sections 1-5 for complete specifications before writing any code.

## Tasks

### TASK 1.1 — Docker Compose + Dockerfiles
Create these files:
- `docker-compose.yml` — 6 services (postgres, minio, redis, imgproxy, worker, dashboard) with healthchecks, volumes, shared `mediavault` bridge network. Copy exact YAML from info.md section 2.
- `.env.example` — All env vars with defaults. Copy from info.md section 3.
- `.gitignore` — Node, Docker, env files, OS files, .DS_Store
- `worker/Dockerfile` — Node.js 20 Alpine, install FFmpeg (`apk add --no-cache ffmpeg`), copy package*.json, npm ci --omit=dev, copy src/, expose 3000
- `dashboard/Dockerfile` — Node.js 20 Alpine, Next.js standalone output mode, multi-stage build

### TASK 1.2 — PostgreSQL Schema + Migrations
Create these files exactly as specified in info.md section 4:
- `worker/migrations/001_initial_schema.sql` — accounts, projects, api_keys, files tables + indexes + triggers
- `worker/migrations/002_usage_tracking.sql` — usage_daily, bandwidth_log, plans tables + seed data
- `worker/migrations/003_webhooks.sql` — webhooks, webhook_deliveries tables
- `worker/migrations/migrate.js` — Migration runner with _migrations tracking table, transactions per file

### TASK 1.3 — Worker Scaffold
Create these files as specified in info.md section 5:
- `worker/package.json` — Dependencies: express, pg, minio, ioredis, multer, sharp, nanoid@3, bcrypt, helmet, cors. Scripts: start, dev (nodemon)
- `worker/src/config.js` — Central config, all env vars read here only, validate required vars, export frozen object
- `worker/src/db.js` — pg Pool singleton, query helper
- `worker/src/minio.js` — MinIO client singleton, ensureBucket helper
- `worker/src/app.js` — Express app factory (no listen), helmet, cors, json parser, routes
- `worker/src/index.js` — Boot: validate config -> connect PG -> run migrations -> ensure MinIO bucket -> connect Redis (optional, graceful fallback) -> create app -> listen

## Rules
- CommonJS only (require/module.exports)
- 2-space indent, semicolons, single quotes
- const by default, async/await everywhere
- No TypeScript in worker
