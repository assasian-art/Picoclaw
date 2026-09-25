#!/bin/sh
set -eu
while :; do
    echo '[Router-Supervisor] starting dynamic free-model router'
    if python3 /app/scripts/model_router.py; then
        status=0
    else
        status=$?
    fi
    echo "[Router-Supervisor] router exited with code ${status}; restarting in 2s" >&2
    sleep 2
done
