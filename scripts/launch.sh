#!/bin/bash

# Wait for WiFi connectivity before starting — the desktop autostart fires before
# NetworkManager finishes connecting. Polls every 2s, gives up after 30s and
# starts anyway (so the app still launches on a network-free setup).
echo "[launch] waiting for network..."
for i in $(seq 1 15); do
    if ping -c 1 -W 1 8.8.8.8 &>/dev/null 2>&1; then
        echo "[launch] network up after ${i} attempts"
        break
    fi
    if [ "$i" -eq 15 ]; then
        echo "[launch] network not available after 30s — starting anyway"
    fi
    sleep 2
done

# TODO: replace zero.py with picamera2-based implementation
# cd ~/peeqo/python
# python zero.py &

cd ~/peeqo/electron
DISPLAY=:0 ./node_modules/.bin/electron main.js

