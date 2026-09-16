# OmniRoute on Railway (always-on, no local PC needed)

This wraps [`diegosouzapw/omniroute:latest`](https://hub.docker.com/r/diegosouzapw/omniroute)
so it can hold state on a Railway Volume, and points `freeopenai` at it over
Railway's private network — no local Docker, no `cloudflared` tunnel, no URL
that rotates on every restart.

## Why the plain Docker image doesn't work on Railway

The image's own entrypoint (`/app/check-permissions.sh`) only *detects* an
unwritable data directory and prints a `chown` command for the operator to
run on the Docker host — right advice for a bind mount you control locally,
useless on Railway, where a Volume is a bind mount to a host path Railway
itself creates and owns as root. The image runs as `node` (uid 1000) and
ships no `gosu`/`su-exec`, so that user has no way to fix it. Deployed as-is,
OmniRoute boots and looks fine, but every write to its SQLite database fails
silently (`EACCES`) and falls back to an in-memory-only mode — every setting
and every connected provider is gone on the next restart, which defeats the
entire point of moving off a local machine.

This directory's `Dockerfile` starts the container as root — the only user
who can `chown` a directory it doesn't own — fixes `/app/data`'s ownership,
then re-execs the image's own entrypoint as `node`, exactly as it ships.
Verified locally against a root-owned, mode-700 volume (the exact shape of a
fresh Railway bind mount): the unwrapped image fails with repeated
`EACCES`/in-memory-only DB; this wrapper boots clean, with
`SQLite database ready` and secrets actually persisted to `/app/data/server.env`.

## Deploying it

1. Railway → your project → **New → GitHub Repo** → this repo, with
   **Root Directory** set to `deploy/omniroute-railway` (Railway builds the
   `Dockerfile` in that folder).
2. Rename the service to `omniroute` (Settings → General) — this is what
   makes its private address predictable.
3. **Settings → Volumes → New Volume**, mount path `/app/data`.
4. **Settings → Variables**:
   ```
   INITIAL_PASSWORD=<pick one>
   JWT_SECRET=<openssl rand -base64 32>
   API_KEY_SECRET=<openssl rand -base64 32>
   REQUIRE_API_KEY=false
   PORT=20128
   ```
   `PORT` matters: Railway auto-injects its own `PORT` (often `8080`), which
   overrides the image's built-in default of `20128` — without this variable
   the app listens on a port nothing is pointed at.
5. **Settings → Networking → Generate Domain**, target port `20128`. You
   need this once, to open the dashboard and connect your providers.
6. Open that URL, log in with `INITIAL_PASSWORD`, connect your providers.
7. Harden it: create an API key in the dashboard, then set
   `REQUIRE_API_KEY=true` here.
8. On the **freeopenai** service (same Railway project), set:
   ```
   OMNIROUTE_BASE_URL=http://omniroute.railway.internal:20128
   OMNIROUTE_API_KEY=<the key from step 7>
   ```
   That's Railway's private network — no public exposure for that traffic.
