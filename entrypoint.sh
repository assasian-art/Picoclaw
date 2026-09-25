#!/bin/sh
set -eu

PORT="${PORT:-8080}"
MODEL_HOST="${LOCAL_MODEL_HOST:-127.0.0.1}"
MODEL_PORT="${LOCAL_MODEL_PORT:-8000}"
ROUTER_HOST="${ROUTER_HOST:-127.0.0.1}"
ROUTER_PORT="${ROUTER_PORT:-8100}"
CLOUDFLARE_TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-${TUNNEL_TOKEN:-}}"
CLOUDFLARE_QUICK_TUNNEL="${CLOUDFLARE_QUICK_TUNNEL:-true}"
MODEL_PATH="/app/models/SmolLM2-135M-Instruct-Q4_K_M.gguf"
PICO_HOME="/root/.picoclaw"
CONFIG_SOURCE="/config/config.json"
CONFIG_PATH="${PICO_HOME}/config.json"

printf '%s\n' '=================================================='
printf '%s\n' ' PicoClaw WebUI + SmolLM2-135M-Instruct + router'
printf ' UTC: %s\n' "$(date -u)"
printf ' Public WebUI port: %s\n' "${PORT}"
printf ' Router API: %s:%s\n' "${ROUTER_HOST}" "${ROUTER_PORT}"
printf ' Local model API: %s:%s\n' "${MODEL_HOST}" "${MODEL_PORT}"
printf '%s\n' '=================================================='

mkdir -p "${PICO_HOME}/workspace" "${PICO_HOME}/logs"
cp "${CONFIG_SOURCE}" "${CONFIG_PATH}"

export PICOCLAW_BINARY="/app/picoclaw"
export LOCAL_MODEL_ID="smollm2-135m"
export ROUTER_CONFIG_FILE="${CONFIG_PATH}"
export GATEWAY_RELOAD_TOKEN="${PICOCLAW_GATEWAY_TOKEN:-picoclaw-internal-reload}"
export ROUTER_GATEWAY_RELOAD_URL="http://127.0.0.1:18790/reload"
export ROUTER_GATEWAY_RELOAD_TOKEN="${GATEWAY_RELOAD_TOKEN}"
export PICOCLAW_GATEWAY_TOKEN="${GATEWAY_RELOAD_TOKEN}"
export ROUTER_FREE_ONLY="true"

printf '%s\n' '--- binaries ---'
ls -lh /app/picoclaw /app/picoclaw-launcher /app/llama-server
printf '%s\n' '--- local text model ---'
ls -lh "${MODEL_PATH}"
printf '%s\n' '--- PicoClaw version ---'
/app/picoclaw version || true
printf '%s\n' '--- llama.cpp version ---'
/app/llama-server --version || true

/app/scripts/model_supervisor.sh &
MODEL_SUPERVISOR_PID=$!

/app/scripts/router_supervisor.sh &
ROUTER_SUPERVISOR_PID=$!

cleanup() {
    kill "${MODEL_SUPERVISOR_PID}" 2>/dev/null || true
    kill "${ROUTER_SUPERVISOR_PID}" 2>/dev/null || true
    if [ -n "${CLOUDFLARE_PID}" ]; then kill "${CLOUDFLARE_PID}" 2>/dev/null || true; fi
}
trap cleanup INT TERM EXIT

i=0
while ! curl -fsS "http://${MODEL_HOST}:${MODEL_PORT}/health" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "${i}" -ge 180 ]; then
        echo 'ERROR: SmolLM2-135M local model did not become healthy within 180s.' >&2
        exit 1
    fi
    sleep 1
done
echo 'SmolLM2-135M local model: healthy'

i=0
while ! curl -fsS "http://${ROUTER_HOST}:${ROUTER_PORT}/health" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "${i}" -ge 120 ]; then
        echo 'ERROR: model router did not become healthy within 120s.' >&2
        exit 1
    fi
    sleep 1
done

echo 'Model router: healthy'

CLOUDFLARE_PID=""
if [ "${CLOUDFLARE_QUICK_TUNNEL}" = "true" ] || [ "${CLOUDFLARE_QUICK_TUNNEL}" = "1" ]; then
    echo 'Starting Cloudflare Quick Tunnel (tokenless)...'
    (
        while :; do
            cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" 2>&1 | while IFS= read -r line; do
                echo "[Cloudflare Quick Tunnel] ${line}"
                case "${line}" in
                    *trycloudflare.com*) echo "PUBLIC_QUICK_TUNNEL_URL=$(printf '%s' "${line}" | grep -Eo 'https://[^ ]*trycloudflare\.com' | head -n1 || true)" ;;
                esac
            done
            echo 'Cloudflare Quick Tunnel exited; restarting in 5s...' >&2
            sleep 5
        done
    ) &
    CLOUDFLARE_PID=$!
elif [ -n "${CLOUDFLARE_TUNNEL_TOKEN}" ]; then
    echo 'Starting Cloudflare named tunnel...'
    (
        while :; do
            cloudflared tunnel --no-autoupdate run --token "${CLOUDFLARE_TUNNEL_TOKEN}" || true
            echo 'Cloudflare Tunnel exited; restarting in 5s...' >&2
            sleep 5
        done
    ) &
    CLOUDFLARE_PID=$!
else
    echo 'Cloudflare Tunnel: disabled'
fi

/app/scripts/auth_bootstrap.sh &

echo 'Starting official PicoClaw WebUI launcher...'
while :; do
    status=0
    /app/picoclaw-launcher \
        -host 0.0.0.0 \
        -port "${PORT}" \
        -public \
        -no-browser \
        "${CONFIG_PATH}" || status=$?

    echo "[Launcher-Supervisor] launcher exited with code ${status}; restarting in 2s" >&2
    sleep 2
done
