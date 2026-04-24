"use strict";

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const event = require("js/events/events");
const mic = require("js/senses/mic");
const config = require("config/config");
const debug = require("js/helpers/debug");

// Path to the Python detector script (relative to electron/ working directory)
const WAKEWORD_SCRIPT = path.join(process.cwd(), "..", "python", "wakeword.py");

// Model file lives alongside other config assets
const MODEL_PATH = config.speech.wakewordModel
    ? path.join(process.cwd(), "app", "config", config.speech.wakewordModel)
    : null;

// How long to wait before re-attaching the mic to the detector after a response.
const REWAKE_DELAY_MS = 1000;

function startListening() {
    const args = ["--threshold", String(config.speech.wakewordThreshold || 0.5)];
    if (MODEL_PATH) args.push("--model", MODEL_PATH);

    let detector;
    try {
        detector = spawn("python3", [WAKEWORD_SCRIPT, ...args], {
            stdio: ["pipe", "pipe", "pipe"],
        });
    } catch (err) {
        console.error("[listen] failed to spawn wakeword detector:", err);
        return;
    }

    // Guard flag — prevents stacked wakeword events if Python emits multiple
    // WAKEWORD signals before the cooldown suppresses them on its side.
    // Reset when pipe-to-wakeword fires (i.e. the full response cycle is done).
    let detected = false;

    // Debounce timer for pipe-to-wakeword — multiple events can fire per cycle
    // (one from setAnswer's mic-resume, one from end-speech-to-text's mic-resume).
    // We only want to act on the last one.
    let rewakeTimer = null;

    // Don't pipe until Python signals "ready". The model takes ~8–15s to load;
    // piping earlier queues that audio in Python's stdin. Python drains its stdin
    // on startup, but we also avoid sending stale audio in the first place.
    let initialPipeConnected = false;

    // Log Python stderr (model loading info, detection scores, errors).
    // Also watch for the "ready" line to connect the initial mic pipe.
    detector.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        debug("[wakeword]", msg);

        if (!initialPipeConnected && msg.includes("ready, listening on stdin")) {
            initialPipeConnected = true;
            const stream = mic.getMic();
            if (stream) {
                stream.pipe(detector.stdin, { end: false });
                event.emit("status-listening");
                debug("[listen] detector ready — mic piped to detector");
            }
        }
    });

    // Stdout carries a single signal: "WAKEWORD"
    detector.stdout.on("data", (data) => {
        if (data.toString().includes("WAKEWORD") && !detected) {
            detected = true;
            mic.getMic().unpipe(detector.stdin);
            event.emit("wakeword");
        }
    });

    detector.on("error", (err) => {
        if (err.code === "ENOENT") {
            console.error("[listen] python3 not found — install Python 3 and run: pip3 install openwakeword");
        } else {
            console.error("[listen] detector process error:", err);
        }
    });

    detector.on("close", (code) => {
        debug(`[listen] wakeword detector exited (code ${code})`);
    });

    // Suppress EPIPE — thrown when Python process dies and Node writes to its stdin
    detector.stdin.on("error", (err) => {
        if (err.code !== "EPIPE") console.error("[listen] stdin error:", err);
    });

    // After each full response cycle, re-attach the mic to the detector.
    // Debounced: multiple pipe-to-wakeword events per cycle (from setAnswer and
    // end-speech-to-text) are collapsed into one, acting after REWAKE_DELAY_MS.
    // mic.resume() already started a fresh arecord; we just re-pipe it here.
    event.on("pipe-to-wakeword", () => {
        detected = false;
        if (rewakeTimer) clearTimeout(rewakeTimer);
        rewakeTimer = setTimeout(() => {
            rewakeTimer = null;
            const stream = mic.getMic();
            if (stream) {
                stream.pipe(detector.stdin, { end: false });
                event.emit("status-listening");
                debug("[listen] mic re-piped to detector after response");
            }
        }, REWAKE_DELAY_MS);
    });
}

module.exports = { startListening };
