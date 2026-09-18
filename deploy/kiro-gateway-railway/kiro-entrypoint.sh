#!/bin/sh
# Reconcile the human way of installing a token (paste a fresh one into a
# Railway variable) with the gateway's way of keeping one (Kiro rotates the
# refresh token on every refresh, and only the account system's
# credentials.json on a volume holds the current value).
#
# Rule, decided by SHA-256 fingerprint and, when they differ, one liveness
# probe against Kiro itself -- the secret is never logged:
#   * env matches the file (or env unset) -> the file wins: whatever rotation
#     wrote there IS the live token.
#   * env differs -> probe the env token: 401 (dead/stale) -> keep the file;
#     200 (a fresh paste) -> install it, saving the rotated token Kiro hands
#     back, so the paste's freshness is captured at the only moment it exists.
#   * probe inconclusive (network, 5xx) -> keep the file; never clobber on doubt.
#
# Before any of that: a startup backoff. main.py refreshes the token once at
# boot with no retry of its own (kiro/auth.py's _refresh_token_kiro_desktop
# is one bare httpx call), so a real 429 from Kiro's refresh endpoint fails
# the whole startup -- and Railway's default restart-on-crash policy retries
# almost immediately, which re-triggers the same rate limit before it has
# any chance to clear, forever. That loop, not a dead token, is what a
# crash-loop referencing the same account over and over usually is. The
# backoff below is the fix: track how recently this container last tried to
# boot, on the volume so it survives the restart, and if it's trying again
# too soon, sleep first -- longer each consecutive fast restart -- so the
# rate-limit window actually gets a chance to reset before the next attempt.
set -eu

DATA_DIR="${KIRO_DATA_DIR:-/data/kiro}"
CREDS_FILE="$DATA_DIR/credentials.json"
PROBE_URL="${KIRO_REFRESH_PROBE_URL:-https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken}"
fp() { printf '%s' "$1" | sha256sum | cut -c1-12; }

mkdir -p "$DATA_DIR"

# --- Startup backoff: throttle a rapid crash-restart cycle -----------------

BOOT_TS_FILE="$DATA_DIR/last_boot_attempt"
BOOT_COUNT_FILE="$DATA_DIR/fast_restart_count"
NOW=$(date +%s)
LAST=0
[ -f "$BOOT_TS_FILE" ] && LAST=$(cat "$BOOT_TS_FILE" 2>/dev/null) || true
case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac
COUNT=0
[ -f "$BOOT_COUNT_FILE" ] && COUNT=$(cat "$BOOT_COUNT_FILE" 2>/dev/null) || true
case "$COUNT" in ''|*[!0-9]*) COUNT=0 ;; esac

ELAPSED=$((NOW - LAST))
if [ "$LAST" -gt 0 ] && [ "$ELAPSED" -lt 120 ]; then
    COUNT=$((COUNT + 1))
else
    COUNT=0
fi
echo "$NOW" > "$BOOT_TS_FILE"
echo "$COUNT" > "$BOOT_COUNT_FILE"

if [ "$COUNT" -gt 0 ]; then
    case "$COUNT" in
        1) DELAY=15 ;;
        2) DELAY=30 ;;
        3) DELAY=60 ;;
        4) DELAY=120 ;;
        *) DELAY=300 ;;
    esac
    echo "[entrypoint] restarted $COUNT time(s) within the last 2 minutes -- backing off ${DELAY}s before trying again (most often Kiro's refresh endpoint rate-limiting rapid restarts, not a dead token)."
    sleep "$DELAY"
fi

# --- Credential reconciliation ----------------------------------------------

CLEAN=""
if [ -n "${REFRESH_TOKEN:-}" ]; then
    if printf '%s' "$REFRESH_TOKEN" | grep -q '{'; then
        # The whole JSON file was pasted instead of the value: parse it for
        # real rather than sed-guessing (field order is not guaranteed).
        CLEAN=$(REFRESH_TOKEN="$REFRESH_TOKEN" python3 -c '
import json,os,sys
raw=os.environ.get("REFRESH_TOKEN","")
try:
    d=json.loads(raw)
    t=(d.get("refreshToken") or d.get("refresh_token") or "") if isinstance(d,dict) else ""
except Exception:
    t=""
sys.stdout.write(t.strip())
')
        if [ -n "$CLEAN" ]; then
            echo "[entrypoint] REFRESH_TOKEN was a JSON file -> extracted the refreshToken field."
        fi
    fi
    if [ -z "$CLEAN" ]; then
        # Plain paste: tolerate whitespace, smart quotes, stray quote chars.
        CLEAN=$(printf '%s' "$REFRESH_TOKEN" \
            | tr -d '\r\n"' \
            | tr -d '\342\200\234\342\200\235' \
            | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
        if [ "$CLEAN" != "$REFRESH_TOKEN" ] && [ -n "$CLEAN" ]; then
            echo "[entrypoint] REFRESH_TOKEN needed light cleanup (whitespace/quotes); applied."
        fi
    fi
    if [ -z "$CLEAN" ]; then
        echo "[entrypoint] REFRESH_TOKEN cleaned to nothing -- ignoring it (keeping stored credentials)."
    fi
fi

file_token() {
    # python3, not node: this is a python image. Handles both shapes the
    # gateway writes -- the account-system array and the bare-JSON file.
    python3 -c '
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    t=""
else:
    if isinstance(d,list):
        a=next((e for e in d if isinstance(e,dict) and e.get("type")=="refresh_token"),None)
        t=(a or {}).get("refresh_token","")
    elif isinstance(d,dict):
        t=d.get("refreshToken") or d.get("refresh_token") or ""
    else:
        t=""
sys.stdout.write(t)
' "$1" 2>/dev/null || true
}

install_token() {
    printf '[{"type":"refresh_token","refresh_token":"%s"}]' "$1" > "$CREDS_FILE"
    echo "[entrypoint] installed token fp=$(fp "$1") into $CREDS_FILE"
}

if [ -n "$CLEAN" ]; then
    FILE_TOKEN=""
    if [ -f "$CREDS_FILE" ]; then
        FILE_TOKEN=$(file_token "$CREDS_FILE")
    fi

    if [ -n "$FILE_TOKEN" ] && [ "$(fp "$CLEAN")" = "$(fp "$FILE_TOKEN")" ]; then
        echo "[entrypoint] REFRESH_TOKEN matches stored credentials -> keeping the (possibly rotated) file."
    else
        echo "[entrypoint] REFRESH_TOKEN differs from stored credentials -> probing env token liveness."
        rm -f "$DATA_DIR/rotated.tmp"
        PROBE_STATUS=$(REFRESH_TOKEN="$CLEAN" PROBE_URL="$PROBE_URL" ROTATED_OUT="$DATA_DIR/rotated.tmp" python3 -c '
import json,os,sys,urllib.request,urllib.error
tok=os.environ.get("REFRESH_TOKEN",""); url=os.environ.get("PROBE_URL",""); out=os.environ.get("ROTATED_OUT","")
req=urllib.request.Request(url,data=json.dumps({"refreshToken":tok}).encode("utf-8"),
    headers={"Content-Type":"application/json","User-Agent":"KiroIDE-0.7.45-FFFFFFFF-FFFF-FFFF"})
try:
    r=urllib.request.urlopen(req,timeout=15)
    status=r.status; body=r.read()
except urllib.error.HTTPError as e:
    status=e.code; body=e.read()
except Exception:
    print("STATUS ERR"); sys.exit(0)
print("STATUS "+str(status))
try:
    d=json.loads(body.decode("utf-8"))
    nt=d.get("refreshToken") if isinstance(d,dict) else ""
    if nt: open(out,"w").write(nt)
except Exception:
    pass
' 2>/dev/null | sed -n 's/^STATUS //p')

        case "$PROBE_STATUS" in
            200)
                if [ -s "$DATA_DIR/rotated.tmp" ]; then
                    NEW_TOKEN=$(cat "$DATA_DIR/rotated.tmp")
                    rm -f "$DATA_DIR/rotated.tmp"
                    echo "[entrypoint] env token is live; Kiro rotated it on the probe -> installing the rotated token."
                    install_token "$NEW_TOKEN"
                else
                    echo "[entrypoint] env token is live (no rotation returned) -> installing it."
                    install_token "$CLEAN"
                fi
                ;;
            401|403)
                echo "[entrypoint] env token is dead (Kiro rejected it) -> keeping stored credentials."
                ;;
            429)
                echo "[entrypoint] probe was rate-limited (429) -> keeping stored credentials; this is not a sign the token is dead."
                ;;
            *)
                echo "[entrypoint] probe inconclusive (status=${PROBE_STATUS:-none}) -> keeping stored credentials (safe default)."
                ;;
        esac
    fi
else
    echo "[entrypoint] no REFRESH_TOKEN set -- relying on stored credentials."
fi

chown -R kiro:kiro "$DATA_DIR" 2>/dev/null || true
if command -v gosu >/dev/null 2>&1; then
    exec gosu kiro "$@"
fi
exec "$@"
