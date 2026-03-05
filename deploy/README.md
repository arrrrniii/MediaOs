# Reverse Proxy Examples

MediaOS exposes two ports by default:

| Service | Port | Routes |
|---------|------|--------|
| **Worker API** | 3000 | `/api/v1/*`, `/f/*`, `/img/*`, `/health` |
| **Dashboard** | 3001 | Everything else |

All other services (PostgreSQL, Redis, MinIO, imgproxy) are internal only — no exposed ports.

## Single Domain Setup

Put both behind a reverse proxy on one domain:

```
cdn.yourdomain.com/api/v1/*  → worker:3000
cdn.yourdomain.com/f/*       → worker:3000
cdn.yourdomain.com/img/*     → worker:3000
cdn.yourdomain.com/*         → dashboard:3001
```

## Configs

| File | Proxy | Notes |
|------|-------|-------|
| [`nginx.conf`](nginx.conf) | Nginx | Most common. Use `certbot` for SSL. |
| [`Caddyfile`](Caddyfile) | Caddy | Auto HTTPS, zero config SSL. |
| [`traefik-labels.yml`](traefik-labels.yml) | Traefik | Docker labels for existing Traefik setup. |

## Without a Reverse Proxy

Access services directly on their ports:

- **Dashboard:** `http://your-server:3001`
- **API:** `http://your-server:3000`

Set `PUBLIC_URL` and `DASHBOARD_URL` in `.env` accordingly.
