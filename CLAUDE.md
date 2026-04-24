# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Internal Docs (`_dev/`)

The `_dev/` directory contains planning and reference documents that are gitignored (not published). Check here for context before starting work:

- `_dev/HARDWARE.md` — physical assembly notes, servo wiring, V+ power check
- `_dev/IDEAS.md` — future improvement ideas (e.g. Tenor GIF swap)
- `_dev/LLM_UPGRADE.md` — notes on the Claude agent migration from Dialogflow
- `_dev/OPTIMIZATIONS.md` — performance tuning notes

## Project Overview

Peeqo is an Electron-based desktop robot interface designed to run on a **Raspberry Pi 3B** (or Mac/Linux for development). It listens for a wakeword, captures speech, sends it to Google Dialogflow for intent recognition, and responds with GIFs/videos, servo movements, LED animations, and sounds.

## Target Hardware

- **Raspberry Pi 3B** (armv7l, 32-bit) running Pi OS Bullseye
- Development is done on Mac/Linux; code is rsync'd to the Pi (see Deploying section)
- Always add npm packages to `electron/package.json` by hand — never run `npm install <pkg>` directly, as the Pi picks up dependencies from package.json after sync

## Prerequisites

- Node 20 (via nvm: `nvm install 20`)
- `brew install sox` on Mac / `sudo apt install sox` on Pi (mic recording on Mac via `rec`; audio resampling on Pi via `sox` — WM8960 clock locks to 16kHz when mic is active so all sounds must be resampled before playback)
- `brew install yt-dlp` on Mac / `pip3 install yt-dlp` on Pi (for YouTube video playback)
- On Raspberry Pi: `arecord` is used instead of `rec`
- Google Dialogflow credentials: `dialogflow.json` key file placed in `electron/app/config/`
- Python 3 + openWakeWord (Raspberry Pi only, for wakeword detection):
  ```bash
  sudo apt install -y libopenblas-dev
  # armv7l (32-bit) only — skip on arm64/x86:
  pip3 install "https://github.com/nknytk/built-onnxruntime-for-raspberrypi-linux/raw/master/wheels/bullseye/onnxruntime-1.16.0-cp39-cp39-linux_armv7l.whl"
  pip3 install -r python/requirements.txt
  ```

## Running

```bash
cd electron
npm install
npm start          # normal mode
npm run debug      # with DevTools forced open (useful on Pi)
npm run rebuild    # rebuild native modules after electron version change
```

On Mac/non-ARM Linux, DevTools always open automatically. On Pi, only when `NODE_ENV=debug`.

If `npm run rebuild` gives a permission error: `chmod +x node_modules/@electron/rebuild/lib/cli.js`

## Pi OS One-Time Setup

This Pi OS Bullseye install uses **ConnMan** (`connmand`) as the network manager — not
NetworkManager (`nmcli` is absent). ConnMan manages WiFi through `wpa_supplicant` and
`dhcpcd` under the hood.

WiFi SSID/password is stored in `/etc/wpa_supplicant/wpa_supplicant-wlan0.conf`.

**If WiFi doesn't auto-connect at boot**, the likely cause is ConnMan has WiFi disabled
(`Enable=false` in `/var/lib/connman/settings`). Fix with one command:
```bash
sudo connmanctl enable wifi
```
This writes `Enable=true` to `/var/lib/connman/settings` persistently.

`scripts/launch.sh` also includes a 30-second network wait loop so the Electron app
doesn't start before WiFi is up.

## Deploying to Raspberry Pi

Use `rsync` — `scp -r` without a trailing slash creates nested duplicate directories:

```bash
rsync -av --exclude='node_modules' /Users/cody/dev/peeqo-personal/electron/ pi@<ip>:~/peeqo/electron/
```

After syncing, rebuild native modules on the Pi:

```bash
cd ~/peeqo/electron && npm run rebuild
```

## Architecture

### Entry Points

- `electron/main.js` — Electron shell; creates the BrowserWindow, sets fullscreen on Pi, loads hardware modules
- `electron/app/index.html` — Single page loaded in the window; pulls in `global.js`
- `electron/app/js/global.js` — Bootstraps all modules, wires the wakeword button, initializes eyes/glasses/LEDs/servos

### Event-Driven Core

All inter-module communication goes through a central EventEmitter in `js/events/events.js`. Modules communicate exclusively by emitting and listening to named events — no direct function calls between subsystems. `js/events/listeners.js` is where all global event bindings are registered at startup.

Key event flow:
1. User says wakeword → `wakeword` event
2. `wakeword` → (a) `actions.wakeword()` plays alert sound/servo, (b) `dialogflow.prepare()` opens gRPC connection, (c) `speech-to-text` fires immediately (parallel to alert)
3. `speech-to-text` → `dialogflow.startAudio()` pipes mic after `audioStartDelayMs` (500ms default, covers alert + echo)
4. Dialogflow returns intent → `final-command` event with `{ intent, params, queryText, responseText }`
5. `final-command` → `dialogflow-intents.parseIntent()` → dispatches to skill handlers
6. Skill/action calls `actions.setAnswer(responseObj)` → finds media, pauses mic, plays media with eye/LED/servo animations, resumes mic

### Response Pipeline (`actions.setAnswer`)

The response object shape (defined in `js/responses/responses.js`):
```js
{
  type: 'local' | 'remote' | 'wakeword',  // local = pick from app/media/responses/<localFolder>/, remote = Giphy search
  localFolder: 'folderName',               // subfolder under app/media/responses/
  queryTerms: ['search', 'terms'],         // used when type='remote' for Giphy/Vlipsy
  servo: 'animName',                       // JSON anim file in app/media/servo_anims/
  led: { anim: 'circle', color: 'aqua' },
  sound: 'file.wav',                       // in app/media/sounds/
  text: 'overlay text',
  cbBefore / cbDuring / cbAfter            // lifecycle callbacks
}
```

Mic is automatically paused during media playback (when duration is non-null) and resumed after.

### Adding a New Intent/Skill

1. Add a response definition to `js/responses/responses.js`
2. Add a `case` for the intent name in `js/intent-engines/dialogflow-intents.js`
3. Add local media files to `electron/app/media/responses/<intentName>/` if using `type: 'local'`
4. Train the intent in the Dialogflow agent (export/import via `app/config/dialogflow-agent.zip`)

### Main Process vs Renderer — Native Modules

Electron 14+ blocks non-NAPI (NAN-based) native addons in the renderer. The following modules are **NAN-based** and must run in the main process, forwarding events to the renderer via IPC:

- **`rpi-gpio`** — loaded in `main.js`, GPIO changes sent via `ipcMain` → `ipcRenderer` as `gpio-change`
- **`pi-spi`** (DotStar LEDs) — loaded in `leds-main.js`, animation commands received via `led-on` / `led-off` IPC

**NAPI-based** (safe to load in renderer):
- `i2c-bus` v5+ — used by `servo.js` directly in the renderer

All hardware modules guard initialization with:
```js
const isARM = os.platform() === 'linux' && (os.arch() === 'arm' || os.arch() === 'arm64')
```
This correctly distinguishes a Raspberry Pi from an Apple Silicon Mac (both are ARM but different platforms).

Hardware initialization that can fail (I2C bus, SPI device) is wrapped in try/catch so a missing peripheral never crashes the renderer.

### Wakeword Detection (openWakeWord)

Wakeword detection runs as a Python subprocess (`python/wakeword.py`). Node.js pipes raw mic audio to its stdin; the script writes `"WAKEWORD\n"` to stdout when the keyword is detected. This avoids the NAN/Electron renderer incompatibility that made Snowboy unworkable.

**Flow:**
1. `listen.startListening()` spawns `python3 python/wakeword.py --model app/config/peeqo.onnx`
2. Mic audio is piped to the process's stdin continuously
3. On detection: mic is unpiped, `wakeword` event fires, Dialogflow takes over the mic
4. After the full response cycle, `pipe-to-wakeword` event re-attaches the mic to the detector

**Model file (`electron/app/config/peeqo.onnx`):**
The `.onnx` model file is committed to the repo so other users don't need to train their own. If it's missing, set `speech.wakewordModel: null` in `config.js` to fall back to openWakeWord's built-in models (for testing only — they won't respond to "Peeqo").

**Training a custom "Peeqo" model:**
openWakeWord trains from synthetic TTS data — you don't need to record your own voice samples. Use the [openWakeWord training Colab notebook](https://github.com/dscripka/openWakeWord#training-new-models):
1. Open the Colab notebook linked in the openWakeWord README
2. Set the target phrase to `"peeqo"` (or `"hey peeqo"`)
3. Run all cells — it generates TTS samples and trains the model (~30 min on Colab GPU)
4. Download the resulting `.onnx` file and place it at `electron/app/config/peeqo.onnx`
5. Commit to repo so all users benefit

**Tuning:**
- `speech.wakewordThreshold` in `config.js` — raise (e.g. `0.7`) to reduce false positives, lower (e.g. `0.3`) if it misses the wakeword
- The Python script logs detection scores to stderr (visible as `[wakeword]` lines in the Electron console)

**Dev machines (Mac/Windows):**
On non-Pi platforms, `global.js` shows the clickable wakeword debug button instead of starting the detector. Set `OS=unsupported` to force button mode on any platform.

### Hardware Modules

- `js/senses/mic.js` — Wraps `node-record-lpcm16`; uses `rec` on Mac, `arecord` on Pi; singleton; has `pause()`/`resume()` for muting during media playback
- `electron/leds-main.js` — DotStar LED animations running in main process via `pi-spi`; renderer sends IPC commands
- `js/senses/leds.js` — Renderer-side IPC relay for LEDs; on non-Pi platforms is a no-op
- `js/senses/servo.js` — Controls servos via PCA9685 over I2C; gracefully skipped if I2C unavailable
- `js/senses/buttons.js` — Receives GPIO button events from main process via IPC
- `js/face/eyes.js` — SVG-based animated eyes rendered with Snap.svg
- `js/face/glasses.js` — Overlays glasses image; cycles through `app/media/imgs/glasses/` on `change-glasses` event

### Dialogflow STT Flow

`js/intent-engines/dialogflow.js` uses a two-phase approach to avoid cadence/timing issues:

- **`prepare()`** — called on `wakeword`; opens gRPC stream immediately so the connection is ready before audio flows. Also called at app startup (`dialogflow.warmup()` in `global.js`) to pre-warm the TLS handshake — without this the first detection takes ~5s.
- **`startAudio()`** — called on `speech-to-text`; waits `AUDIO_START_DELAY_MS` before piping mic audio. `speech-to-text` fires at wakeword time (parallel to alert playback), so `AUDIO_START_DELAY_MS` = full wakeword-to-Dialogflow gap.

**Wakeword-to-recording latency:**

The total time from wakeword detection to when Dialogflow hears audio is `speech.audioStartDelayMs` (default 500ms). This must be ≥ alert sound duration + room echo. To reduce it:
1. Replace `app/media/sounds/alert.wav` with a shorter beep (e.g. 150ms click) — this is the biggest lever
2. Lower `speech.audioStartDelayMs` in `config.js` to match the new alert duration + ~60ms echo
3. A 150ms alert → `audioStartDelayMs: 220` → Dialogflow hears audio ~220ms after wakeword (~320ms improvement)

### Wakeword Self-Triggering — Solved

The detector (`python/wakeword.py`) processes audio at CPU speed when a buffer is available. When the mic pipe reconnects after a response, ~1s of buffered audio floods in and can cause an immediate false trigger. Fixed in `wakeword.py` by:
- Using `select()` to detect when stdin has been dry for >500ms (pipe disconnected during response)
- On reconnect: drain all queued stdin data, reset the model's rolling prediction buffer, apply a 1.5s detection cooldown
- At startup: drain any audio that accumulated while the model was loading (~8–15s of model init time)

Do **not** call `mic.startMic()` inside `listen.js`'s `pipe-to-wakeword` handler — this causes ALSA device contention (the new `arecord` fails with exit code 1) because the kernel needs time to release the device after SIGTERM.

### Configuration

`electron/app/config/config.js` — all API keys and settings:
- `giphy.key` — Giphy API key
- `speech.projectId` — Dialogflow GCP project ID
- `speech.dialogflowKey` — filename of the JSON credentials file (in `app/config/`)
- `speech.wakewordThreshold` — detection sensitivity (0.65 default; raise to reduce false positives)
- `speech.audioStartDelayMs` — ms from wakeword to Dialogflow audio start (500ms default; lower if alert is short)
- `openweather.key` / `openweather.city`
- `vlipsy.key`
- `spotify.clientId` / `clientSecret`

### Physical Buttons (Raspberry Pi)

Four buttons are wired to BCM GPIO pins **4, 16, 17, 23**. GPIO events flow from `main.js` (main process, via `rpi-gpio`) to the renderer via IPC as `gpio-change { channel, value }`. `buttons.js` handles short vs long press (3s threshold) and emits named events. `listeners.js` is where actions are assigned.

**Button 16 — "back right"**

| Press | Action |
|-------|--------|
| Short | `power.refresh()` — reloads the Electron renderer (fast software restart) |
| Long  | `power.shutdown()` — powers off the Pi (`sudo shutdown -h now`) |

Button 16 also has a **system-level launcher** (`python/btn_launcher.py`) that runs as a
`systemd` service independent of Electron. When Electron is not running, a short press
launches the app via `scripts/launch.sh`. When Electron is already running it does nothing —
Electron's own handler takes over.

**Installing the launcher service (one-time Pi setup):**
```bash
sudo cp ~/peeqo/scripts/peeqo-launcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable peeqo-launcher
sudo systemctl start peeqo-launcher
```

**Buttons 4, 17, 23** are wired but unassigned — add cases in `listeners.js` to give them behaviour.

### Known Issues / Tech Debt

- `dotstar.js` uses deprecated `new Buffer()` — harmless warning but should be migrated to `Buffer.alloc()`/`Buffer.from()`
- `python/zero.py` is Python 2 and uses the removed `picamera` library; camera launch is commented out in `launch.sh` pending a `picamera2` rewrite
- `electron.remote` was removed in Electron 14; F12 DevTools toggle now uses IPC (`toggle-devtools` event)
- `flite` TTS is not installed by default on Pi (`sudo apt install flite`); weather skill's `speak.speak()` will silently fail without it
