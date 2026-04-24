"use strict";

const recorder = require("node-record-lpcm16");
const os = require("os");
const debug = require("js/helpers/debug");

class Mic {
    constructor() {
        // Determine the recorder to use based on the OS architecture
        this.recorder = os.arch() == "arm" ? "arecord" : "rec";

        this.recorderOpts = {
            verbose: true,
            threshold: 0,
            recorder: this.recorder,
            sampleRate: 16000,
            channels: 1,
        };

        // On Pi, arecord defaults to ALSA card 0 which may not be the mic.
        // The seeed-2mic-voicecard (WM8960) needs to be specified explicitly.
        if (this.recorder === "arecord") {
            this.recorderOpts.device = "plughw:seeed2micvoicec,0";
        }

        this.recordingProcess = null;
        this.paused = false;
        this.startMic();
    }

    startMic() {
        // Stop any previous recording before starting a new one
        if (this.recordingProcess) {
            this.recordingProcess.stop();
        }

        // Start the recording and capture the process to allow control
        this.recordingProcess = recorder.record(this.recorderOpts);

        // Handle errors during recording
        this.recordingProcess.stream().on("error", (err) => {
            console.error("Microphone recording error:", err);
        });

        debug("Microphone recording started");
        return this.recordingProcess.stream();
    }

    getMic() {
        // Return null when paused so pipe-to-wakeword timers that fire during
        // media playback don't accidentally re-attach the mic to the detector.
        if (this.paused) return null;
        if (this.recordingProcess) {
            return this.recordingProcess.stream();
        }
        console.warn("Microphone has not been initialized or is stopped.");
        return null;
    }

    pause() {
        if (this.recordingProcess) {
            const stream = this.recordingProcess.stream();
            // Unpipe without stopping arecord — keeps the WM8960 codec clock active
            // so video audio output continues during the pause. stream.resume() puts
            // it in flowing/discard mode so arecord's pipe buffer never fills.
            stream.unpipe();
            stream.resume();
            this.paused = true;
            debug("Microphone paused");
        }
    }

    resume() {
        this.paused = false;
        if (!this.recordingProcess) {
            this.startMic();
        }
        debug("Microphone resumed");
    }
}

const mic = new Mic();

module.exports = mic;
