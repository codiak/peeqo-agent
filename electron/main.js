"use strict";

const { app, BrowserWindow, ipcMain, session } = require("electron");
const os = require("os");
const fs = require("fs");
const path = require("path");

const isARM =
  os.platform() === "linux" && (os.arch() === "arm" || os.arch() === "arm64");

const debug = require("./app/js/helpers/debug");

// Log file — captures renderer console output across sessions.
// Written to <repo>/logs/peeqo.log so it's easy to find on both Mac and Pi.
const LOG_DIR = path.join(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "peeqo.log");
let logStream = null;

function openLogStream() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    debug(`[main] logging renderer output to: ${LOG_FILE}`);
  } catch (err) {
    console.error("[main] could not open log file:", err);
  }
}

openLogStream();
debug(`[main] platform=${os.platform()} arch=${os.arch()} isARM=${isARM}`);

// Load LED and servo modules in main process on ARM (NAN-based, cannot run in renderer)
if (isARM) {
  require("./leds-main").setup();
  require("./servo-main").setup();
}

let mainWindow = null;

var createWindow = () => {
  // On Pi, set the seeed WM8960 card as PipeWire's default sink before Chromium
  // starts — Electron 35 / Chromium 130 uses PipeWire on Pi OS Bookworm and may
  // default to HDMI or null, leaving video element audio silent.
  if (isARM) {
    const { spawnSync } = require("child_process");
    try {
      const res = spawnSync("pactl", ["list", "short", "sinks"], { encoding: "utf8" });
      if (res.status === 0) {
        debug("[main] PipeWire sinks:", res.stdout.trim().replace(/\n/g, " | "));
        const seeedLine = res.stdout.split("\n").find(l => /seeed|wm8960|voicecard|soc_sound/i.test(l));
        if (seeedLine) {
          const sinkName = seeedLine.split("\t")[1];
          spawnSync("pactl", ["set-default-sink", sinkName]);
          // Keep sink RUNNING so there's no wake-up latency when video plays.
          // Without this the sink suspends between uses and drops the first ~500ms of audio.
          spawnSync("pactl", ["suspend-sink", sinkName, "0"]);
          debug("[main] set PipeWire default sink (no-suspend):", sinkName);
        } else {
          // seeed card not yet registered with PipeWire — load it as an ALSA sink.
          // The capture side is held by arecord but playback is independent on WM8960.
          // Must match arecord's rate (16kHz) so the codec clock is consistent.
          debug("[main] loading seeed card as PipeWire sink via module-alsa-sink...");
          const load = spawnSync("pactl", [
            "load-module", "module-alsa-sink",
            "device=plughw:seeed2micvoicec,0",
            "rate=16000", "channels=1",
            "sink_name=seeed_out",
            "sink_properties=device.description=Seeed-WM8960",
          ], { encoding: "utf8" });
          if (load.status === 0) {
            spawnSync("pactl", ["set-default-sink", "seeed_out"]);
            spawnSync("pactl", ["suspend-sink", "seeed_out", "0"]);
            debug("[main] seeed sink loaded and set as default");
          } else {
            console.warn("[main] could not load seeed sink:", load.stderr?.trim());
          }
        }
      } else {
        console.warn("[main] pactl not available — skipping PipeWire sink setup");
      }
    } catch (e) {
      console.error("[main] pactl error:", e.message);
    }
  }

  mainWindow = new BrowserWindow({
    width: 800,
    height: 480,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });

  // display index.html
  mainWindow.loadURL("file://" + __dirname + "/app/index.html");

  // Mirror renderer console.log / warn / error to the log file.
  const LEVELS = ["verbose", "info", "warning", "error"];
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    const ts = new Date().toISOString();
    const lvl = LEVELS[level] || "info";
    const entry = `${ts} [renderer:${lvl}] ${message}\n`;
    process.stdout.write(entry);
    if (logStream) logStream.write(entry);
  });

  if (isARM) {
    // For Raspberry Pi

    if (process.env.NODE_ENV == "debug") {
      // open console only if NODE_ENV=debug is set
      mainWindow.webContents.openDevTools();
    }

    // make application full screen
    mainWindow.setMenu(null);
    mainWindow.setFullScreen(true);
    mainWindow.maximize();

    setupGPIO(mainWindow);
  } else {
    // For Desktop OS - Mac, Windows, Linux

    // always open console on dev machine
    mainWindow.webContents.openDevTools();
  }
};

// rpi-gpio is NAN-based so it runs here in the main process.
// GPIO change events are forwarded to the renderer via IPC.
function setupGPIO(win) {
  let gpio;
  try {
    gpio = require("rpi-gpio");
  } catch (err) {
    console.error("Failed to load rpi-gpio:", err);
    return;
  }

  gpio.setMode(gpio.MODE_BCM);
  const gpios = [4, 16, 17, 23];
  for (const pin of gpios) {
    gpio.setup(pin, gpio.DIR_IN, gpio.EDGE_BOTH);
  }

  gpio.on("change", (channel, value) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("gpio-change", { channel, value });
    }
  });
}

// Renderer requests DevTools toggle via IPC (electron.remote was removed in Electron 14)
ipcMain.on("toggle-devtools", () => {
  if (mainWindow) mainWindow.webContents.toggleDevTools();
});

// yt-dlp URL resolution — persistent Python subprocess to avoid ~300–500ms
// interpreter startup on every request. Falls back to one-shot spawn if the
// server script exits (e.g. yt_dlp module not importable on this platform).
const { execFile } = require("child_process");
const { promisify } = require("util");
const readline = require("readline");
const execFileAsync = promisify(execFile);

// pip3 install puts binaries in ~/.local/bin which may not be in Electron's PATH.
function resolveYtDlp() {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "yt-dlp"),
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return "yt-dlp";
}
const YT_DLP = resolveYtDlp();
debug(`[main] yt-dlp path: ${YT_DLP}`);

const YT_DLP_SERVER_SCRIPT = path.join(__dirname, "..", "python", "ytdlp_server.py");
let ytDlpProc = null;
let ytDlpQueue = []; // { resolve, reject, timer }
let ytDlpAvailable = false;
let ytDlpCrashCount = 0;

function startYtDlpServer() {
  try {
    ytDlpProc = spawn("python3", [YT_DLP_SERVER_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    const startedAt = Date.now();

    const rl = readline.createInterface({ input: ytDlpProc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      ytDlpCrashCount = 0; // successful response — reset crash counter
      const pending = ytDlpQueue.shift();
      if (!pending) return;
      clearTimeout(pending.timer);
      pending.resolve(line.trim() || null);
    });

    ytDlpProc.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      debug("[yt-dlp server]", msg);
      if (msg.includes("ready")) ytDlpAvailable = true;
    });

    ytDlpProc.on("close", (code) => {
      const uptime = Date.now() - startedAt;
      console.warn(`[yt-dlp server] exited (code ${code}, uptime ${uptime}ms)`);
      ytDlpProc = null;
      ytDlpAvailable = false;
      ytDlpQueue.forEach((p) => { clearTimeout(p.timer); p.reject(new Error("yt-dlp server exited")); });
      ytDlpQueue = [];
      ytDlpCrashCount++;
      if (ytDlpCrashCount <= 3) {
        // Back off a bit on repeated crashes (likely import error on this platform)
        setTimeout(startYtDlpServer, ytDlpCrashCount * 2000);
      } else {
        console.warn("[yt-dlp server] giving up after 3 crashes — spawn fallback will be used");
      }
    });

    ytDlpProc.on("error", (err) => console.error("[yt-dlp server] spawn error:", err.message));
  } catch (err) {
    console.error("[yt-dlp server] failed to start:", err.message);
  }
}

startYtDlpServer();

async function ytDlpGetUrl(videoId) {
  if (ytDlpAvailable && ytDlpProc) {
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = ytDlpQueue.findIndex((p) => p.timer === timer);
          if (idx !== -1) ytDlpQueue.splice(idx, 1);
          reject(new Error("yt-dlp server timeout"));
        }, 25000);
        ytDlpQueue.push({ resolve, reject, timer });
        ytDlpProc.stdin.write(videoId + "\n");
      });
    } catch (err) {
      console.warn("[yt-dlp] server request failed, using spawn fallback:", err.message);
    }
  }
  // Fallback: one-shot spawn (slower due to Python startup, but always works)
  const { stdout } = await execFileAsync(YT_DLP, [
    "--no-playlist",
    "--extractor-args", "youtube:player_client=android",
    "--format", "best[height<=480][ext=mp4]/best[height<=480]/best",
    "-g",
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  return stdout.trim() || null;
}

ipcMain.handle("get-youtube-url", (_event, videoId) => ytDlpGetUrl(videoId));

app.disableHardwareAcceleration();

app.on("ready", () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
