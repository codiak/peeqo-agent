# Peeqo

A desktop robot that listens for a wakeword, transcribes your speech, and responds through GIFs, short video clips, servo movements, and LED animations. Powered by an LLM agent that picks media and text in real time.

**Target hardware:** Raspberry Pi 3B running Pi OS Bullseye (11), with a Seeed 2-mic voicecard (WM8960).  
**Dev machines:** Mac or Linux (DevTools open automatically; wakeword button replaces mic detector on unsupported platforms).

---

## How it works

1. Wakeword detected (openWakeWord / Python subprocess) → alert sound + servo wiggle
2. Google Cloud Speech-to-Text transcribes your speech via a streaming gRPC connection
3. An LLM agent (Claude via Anthropic API or OpenRouter) decides how to respond using tools:
   - `findRemoteGif` — searches Giphy and displays an MP4-backed GIF
   - `findRemoteVideo` — searches YouTube and streams a short clip (or full music video)
   - `getWeather` — fetches current conditions via OpenWeather
   - `setTimer` — countdown timer with GIF response
   - `changeGlasses` — cycles Peeqo's glasses
4. Media plays on screen; mic is paused during playback and re-armed afterward
5. Long videos (music, background play) are interruptible — say the wakeword to pause, speak a command or stay silent to resume

---

## Prerequisites

### All platforms

- **Node 20** via nvm:
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash
  . "$HOME/.nvm/nvm.sh"
  nvm install 20
  ```

### Mac (dev machine)

```bash
brew install sox       # mic recording + audio resampling
brew install yt-dlp    # YouTube URL resolution
```

### Raspberry Pi

```bash
sudo apt install -y libopenblas-dev fonts-noto sox   # sox needed for WM8960 16kHz resampling
pip3 install yt-dlp                                  # YouTube URL resolution
```

**Python wakeword dependencies:**
```bash
# armv7l (32-bit) only — no official PyPI wheel for this platform:
pip3 install "https://github.com/nknytk/built-onnxruntime-for-raspberrypi-linux/raw/master/wheels/bullseye/onnxruntime-1.16.0-cp39-cp39-linux_armv7l.whl"

# All platforms:
pip3 install -r python/requirements.txt
```

Download openWakeWord built-in models (one-time, required even when using a custom model):
```bash
python3 -c "from openwakeword.utils import download_models; download_models()"
```

---

## Upgrading from the original Peeqo tutorial

If you built Peeqo using the [original assembly guide](https://github.com/shekit/peeqo/wiki/Assembly), your Pi is likely running Raspbian Buster (or older) with Node 8–10 and the old Dialogflow + Snowboy stack. Here's how to get to the right baseline before following the setup steps above.

### 1 — Upgrade Pi OS to Bullseye

The target OS is **Pi OS Bullseye (11)**, which ships Python 3.9 (required for the armv7l onnxruntime wheel). A clean flash is the most reliable path:

1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Choose **Raspberry Pi OS (Legacy, 32-bit)** — select the "Bullseye" release
3. Flash to SD card; boot and configure WiFi, SSH, etc.

> **Bookworm (12) is not yet supported on 32-bit Pi 3B** — its default Python 3.11 is incompatible with the onnxruntime 1.16 armv7l wheel. Bullseye is the tested baseline.

### 2 — Install Node 20 via nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
```

Add `nvm use 20` to your `~/.bashrc` so it persists across reboots.

### 3 — Re-install the Seeed voicecard driver

The WM8960 driver needs to match your new kernel. Follow the [seeed-voicecard](https://github.com/HinTak/seeed-voicecard) instructions — the original Respeaker repo is unmaintained; use the HinTak fork which tracks current Pi kernels.

### 4 — Continue with the prerequisites above

Once you're on Bullseye + Node 20, follow the standard prerequisite steps from the top of this README.

---

## API keys & credentials

Start by copying the example config:

```bash
cp electron/app/config/config.example.js electron/app/config/config.js
```

Then fill in your keys in `config.js`. This file is gitignored — your keys won't be committed.

### Minimum required to run

| Key | Where to get it | Notes |
|-----|-----------------|-------|
| `anthropic.apiKey` **or** `openrouter.apiKey` | [console.anthropic.com](https://console.anthropic.com/) or [openrouter.ai/keys](https://openrouter.ai/keys) | Anthropic is preferred (faster, caching, streaming) |
| Google Cloud service account JSON | [console.cloud.google.com](https://console.cloud.google.com/) | Enables Speech-to-Text and YouTube search; save as `electron/app/config/dialogflow.json` |
| `giphy.key` | [developers.giphy.com](https://developers.giphy.com/docs/) | Free tier is fine |

### Optional

| Key | Where to get it | Enables |
|-----|-----------------|---------|
| `openweather.key` | [openweathermap.org/api](https://openweathermap.org/api) | Weather skill |

### LLM provider

Set **one** of `anthropic.apiKey` or `openrouter.apiKey` in `config.js`. If both are set, Anthropic is used (it's faster — direct API, prompt caching, streaming tool dispatch). OpenRouter lets you swap to any supported model.

```js
anthropic: {
  apiKey: "sk-ant-...",          // preferred: faster, supports caching + streaming
  model: "claude-haiku-4-5-20251001",
},
openrouter: {
  apiKey: "sk-or-v1-...",        // fallback; set apiKey to "" to use Anthropic
  model: "anthropic/claude-sonnet-4-5",
},
```

### Google Cloud service account

Place your service account JSON file at `electron/app/config/dialogflow.json`. The same key is used for both Speech-to-Text and the YouTube Data API — no separate credentials needed.

---

## Running

```bash
cd electron
npm install
npm start          # normal mode
npm run debug      # with DevTools forced open (useful on Pi)
npm run rebuild    # rebuild native modules after Electron version change
```

On Mac/non-ARM Linux, DevTools always open. On Pi, only when `NODE_ENV=debug`.

**No wakeword hardware?** Pass `OS=unsupported` to show a clickable wakeword button instead:
```bash
OS=unsupported npm start
```

---

## Deploying to Raspberry Pi

```bash
# Sync project files (rsync, not scp — avoids nested duplicate directories)
rsync -av --exclude='node_modules' /path/to/peeqo-personal/electron/ pi@<ip>:~/peeqo/electron/

# Rebuild native modules on the Pi after syncing
cd ~/peeqo/electron && npm run rebuild
```

> Never run `npm install <pkg>` directly. Add packages to `electron/package.json` by hand and let `npm install` pick them up after sync.

### Pi one-time WiFi setup

```bash
sudo raspi-config   # → System Options → Wireless LAN
```

---

## Configuration reference (`electron/app/config/config.js`)

| Key | Description |
|-----|-------------|
| `anthropic.apiKey` / `anthropic.model` | Direct Anthropic API (preferred) |
| `openrouter.apiKey` / `openrouter.model` | OpenRouter fallback |
| `speech.dialogflowKey` | Filename of Google service account JSON in `app/config/` |
| `speech.wakewordModel` | `.onnx` model file in `app/config/` — `null` for openWakeWord built-ins |
| `speech.wakewordThreshold` | Detection sensitivity (default `0.65`; raise to reduce false positives) |
| `speech.audioStartDelayMs` | ms from wakeword to STT audio start (default `50`) |
| `youtube.maxVideoDuration` | Default max clip duration in seconds (default `10`) |
| `giphy.key` | Giphy API key |
| `openweather.key` / `openweather.city` | OpenWeather API key and default city |

---

## Adding a new skill

1. Add a tool definition to `electron/app/js/intent-engines/claude.js` (`TOOLS_ANTHROPIC`) — this is what the LLM calls
2. Add a handler function exported from `electron/app/js/intent-engines/skills.js` — must match the tool name exactly
3. Optionally add a response definition to `electron/app/js/responses/responses.js` if the skill needs a canned local response
4. Add local media to `electron/app/media/responses/<skillName>/` if using `type: 'local'`

---

## Community

- Discord: [bit.ly/2HLtxez](http://bit.ly/2HLtxez)
- Assembly instructions: [wiki](https://github.com/shekit/peeqo/wiki/Assembly)
