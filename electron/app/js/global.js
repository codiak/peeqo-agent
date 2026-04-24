"use strict";

const os = require("os");
require("app-module-path").addPath(__dirname);

const debug = require("js/helpers/debug");
debug("[global] starting — platform:", process.platform, "arch:", process.arch);

const event = require("js/events/events");
const mic = require("js/senses/mic");

let listen = null;

if (process.env.OS !== "unsupported") {
    // only include snowboy for supported OS
    listen = require("js/senses/listen");
}

const Eyes = require("js/face/eyes");
const Glasses = require("js/face/glasses");
const speak = require("js/senses/speak");
const buttons = require("js/senses/buttons");

const listeners = require("js/events/listeners")();

// keyboard shortcuts
const { ipcRenderer } = require("electron");

document.addEventListener("keydown", (e) => {
    if (e.which == 123) {
        // F12 - toggle js console (electron.remote was removed in Electron 14)
        ipcRenderer.send("toggle-devtools");
    } else if (e.which == 116) {
        // F5 - refresh page
        // make sure page is in focus, not console
        location.reload();
    }
});

// initiate eyes and glasses
const eyes = new Eyes();
event.emit("show-div", "eyeWrapper");
event.emit("start-blinking");
const glasses = new Glasses();

setTimeout(() => {}, 3000);

// initiate buttons
buttons.initializeButtons();

//initiate leds and run initial animation
const leds = require("js/senses/leds");
event.emit("led-on", { anim: "circle", color: "aqua" });

// initiate camera
const Camera = require("js/senses/camera");
const camera = new Camera();

// initiate servos (IPC relay — actual driver is in servo-main.js in main process)
const Servo = require("js/senses/servo");
const servo = new Servo();

// initiate text
const text = require("js/senses/text");

// set audio volume level. 0 - mute; 1 - max
// On ARM the WM8960 scale is non-linear; 0.7 ≈ -18dB (comfortably loud).
event.emit("set-volume", 0.7);

// Route the <video> element's audio to the seeed WM8960 card explicitly.
// Electron 35 uses Chromium 130 which on Pi OS Bookworm defaults to PipeWire;
// PipeWire may not have seeed as its default sink, causing silent video audio.
// setSinkId() lets us target the right device without system-level config changes.
(async () => {
    debug("[audio] enumerating output devices...");
    try {
        if (!navigator.mediaDevices) {
            console.warn("[audio] navigator.mediaDevices unavailable");
            return;
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === "audiooutput");
        debug("[audio] outputs:", outputs.map(d => `"${d.label||'?'}" [${d.deviceId.slice(0,8)}]`).join(" | "));

        // Try exact seeed identifiers first; fall back to "Analog Stereo" since the
        // WM8960 shows as "Built-in Audio Analog Stereo" on Pi OS Bookworm while
        // HDMI shows as "Digital Stereo" — analog is always the right choice here.
        const seeed = outputs.find(d =>
            d.label.toLowerCase().includes("seeed") ||
            d.label.toLowerCase().includes("wm8960") ||
            d.label.toLowerCase().includes("voicecard")
        ) || outputs.find(d =>
            d.label.toLowerCase().includes("analog stereo") &&
            !d.label.toLowerCase().includes("digital")
        );

        const video = document.getElementById("video");
        const soundEl = document.getElementById("sound");
        if (seeed) {
            const elements = [video, soundEl].filter(el => el && el.setSinkId);
            await Promise.all(elements.map(el => el.setSinkId(seeed.deviceId)));
            debug("[audio] sinks set to:", seeed.label);
        } else {
            console.warn("[audio] seeed output not found — audio may be silent; check 'pactl list sinks short' on Pi");
        }
    } catch (err) {
        console.error("[audio] setSinkId error:", err.message);
    }
})();

// Log WM8960 mixer levels at startup and ensure both outputs are audible.
if (os.platform() === 'linux') {
    const { exec, spawn: spawnChild } = require('child_process')
    for (const ctl of ['Headphone', 'Speaker']) {
        exec(`amixer -D hw:seeed2micvoicec sget ${ctl} 2>&1 | grep -E 'Front|Mono'`, (err, stdout) => {
            debug(`[audio] WM8960 ${ctl}:`, stdout.trim() || '(not found)')
        })
    }
    // Set both outputs to 80% at startup — WM8960 Speaker defaults to 0 on fresh boot.
    for (const ctl of ['Headphone', 'Speaker']) {
        spawnChild('amixer', ['-D', 'hw:seeed2micvoicec', 'sset', ctl, '80%'], { detached: false })
            .on('error', () => {})
    }
    // Enable WM8960 output mixer routing switches — PCM audio won't flow to the
    // amplifier if these are off, regardless of volume level.
    for (const ctl of ['Left Output Mixer PCM Playback Switch', 'Right Output Mixer PCM Playback Switch']) {
        spawnChild('amixer', ['-D', 'hw:seeed2micvoicec', 'sset', ctl, 'on'], { detached: false })
            .on('error', () => {})
    }
}

// Pre-warm the Google STT gRPC/TLS channel so the first wakeword response isn't slow.
const stt = require("js/intent-engines/stt");
stt.warmup();

// initiate listening or show wakeword button
if (process.env.OS == "unsupported") {
    // pass OS=unsupported to show a clickable wakeword button instead of the mic detector
    // (useful on Windows or systems where openWakeWord/Python is not available)
    document.getElementById("wakeword").addEventListener("click", (e) => {
        e.preventDefault();
        document.getElementById("wakeword").style.backgroundColor = "red";
        event.emit("wakeword");
    });

} else {
    listen.startListening();
    document.getElementById("wakeword").style.display = "none";
}

debug("[global] ready");
