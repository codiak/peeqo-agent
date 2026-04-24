#!/usr/bin/env python3
"""
Monitors GPIO pin 16 and launches the Peeqo Electron app if it isn't running.
Runs as a systemd service at boot (see scripts/peeqo-launcher.service).

When Electron IS running it handles btn-16 itself (refresh / shutdown).
This script only acts when Electron is absent.

Wiring assumption: button is active-high (pull-down resistor, presses to VCC).
This matches the rpi-gpio behaviour observed in testing (value=true when pressed).
If buttons are wired active-low, change PUD_DOWN → PUD_UP and RISING → FALLING.
"""

import RPi.GPIO as GPIO
import subprocess
import os
import time
import sys

BUTTON_PIN = 16  # BCM numbering
LAUNCH_SCRIPT = os.path.expanduser("~/peeqo/scripts/launch.sh")
DEBOUNCE_MS = 80


def is_app_running():
    try:
        result = subprocess.run(
            ["pgrep", "-f", "electron main.js"],
            capture_output=True,
        )
        return result.returncode == 0
    except Exception:
        return False


def on_button_press(channel):
    if not is_app_running():
        print("[btn_launcher] Electron not running — launching app", flush=True)
        subprocess.Popen(["bash", LAUNCH_SCRIPT])
    else:
        print("[btn_launcher] Electron already running — ignoring", flush=True)


def main():
    GPIO.setmode(GPIO.BCM)
    GPIO.setup(BUTTON_PIN, GPIO.IN, pull_up_down=GPIO.PUD_DOWN)
    GPIO.add_event_detect(BUTTON_PIN, GPIO.RISING, callback=on_button_press, bouncetime=DEBOUNCE_MS)

    print(f"[btn_launcher] watching GPIO {BUTTON_PIN} for app launch", flush=True)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        GPIO.cleanup()


if __name__ == "__main__":
    main()
