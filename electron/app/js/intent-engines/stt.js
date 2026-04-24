const { SpeechClient } = require("@google-cloud/speech");
const path = require("path");
const mic = require("js/senses/mic");
const event = require("js/events/events");
const config = require("config/config");
const debug = require("js/helpers/debug");

const AUDIO_START_DELAY_MS = config.speech.audioStartDelayMs ?? 100;

// Single shared client — keeps the gRPC/TLS channel alive across sessions.
const speechClient = new SpeechClient({
    keyFilename: path.join(
        process.cwd(),
        "app",
        "config",
        config.speech.dialogflowKey,
    ),
    fallback: false,
});

const streamingConfig = {
    config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: config.speech.language,
    },
    singleUtterance: true,
    interimResults: false,
};

// Max seconds to wait for a final STT result after audio starts flowing.
// If the stream hangs (no result, no close event), this forces cleanup so the
// wakeword detector is re-armed and the system doesn't stay stuck.
const STT_TIMEOUT_MS = 10000;

class SttStream {
    constructor() {
        this.stream = null;
        this.audioTimer = null;
        this.sttTimeout = null;
        this._sttFired = false;
    }

    prepare() {
        this.stream = speechClient.streamingRecognize(streamingConfig);
        this.stream
            .on("data", this.handleData.bind(this))
            .on("error", this.handleError.bind(this))
            .once("close", this.handleClose.bind(this));
        debug("STT: stream opened, waiting for audio signal");
    }

    startAudio() {
        this.audioTimer = setTimeout(() => {
            const micStream = mic.getMic();
            if (micStream) {
                let byteCount = 0;
                micStream.on("data", (chunk) => {
                    byteCount += chunk.length;
                    if (byteCount === chunk.length) {
                        debug("STT: first audio chunk, bytes:", chunk.length);
                    }
                });
                micStream.pipe(this.stream);
            } else {
                console.error("STT: failed to get microphone stream");
            }

            // Safety net: if the stream hasn't delivered a result or closed cleanly
            // within STT_TIMEOUT_MS, force cleanup so the wakeword detector re-arms.
            this.sttTimeout = setTimeout(() => {
                if (!this._sttFired) {
                    console.warn("STT: timeout — no result received, forcing cleanup");
                    this._sttFired = true;
                    if (this.stream) this.stream.destroy();
                    mic.pause();
                    event.emit("no-command");
                    event.emit("end-speech-to-text");
                }
            }, STT_TIMEOUT_MS);
        }, AUDIO_START_DELAY_MS);
    }

    handleData(data) {
        const result = data.results?.[0];
        if (!result?.isFinal) return;

        this.cleanUp();
        const transcript = result.alternatives?.[0]?.transcript?.trim();
        this.stream.end();
        mic.pause();

        if (transcript) {
            debug("STT: final transcript:", transcript);
            event.emit("final-transcript", { text: transcript });
        } else {
            event.emit("no-command");
        }

        this._sttFired = true;
        event.emit("end-speech-to-text");
    }

    handleError(err) {
        console.error("STT error:", err);
        if (this.stream) this.stream.end();
    }

    handleClose() {
        debug("STT: stream closed");
        this.cleanUp();
        if (pendingStream === this) pendingStream = null;
        if (!this._sttFired) {
            event.emit("end-speech-to-text");
        }
    }

    cleanUp() {
        if (this.audioTimer) {
            clearTimeout(this.audioTimer);
            this.audioTimer = null;
        }
        if (this.sttTimeout) {
            clearTimeout(this.sttTimeout);
            this.sttTimeout = null;
        }
    }
}

let pendingStream = null;

function prepare() {
    if (pendingStream) {
        console.warn("STT: prepare() called while a session is already pending, ignoring");
        return;
    }
    pendingStream = new SttStream();
    pendingStream.prepare();
}

function startAudio() {
    if (!pendingStream) {
        console.error("STT: startAudio() called but no pending stream — was prepare() called?");
        return;
    }
    const stream = pendingStream;
    pendingStream = null;
    stream.startAudio();
    debug(`STT: piping audio in ${AUDIO_START_DELAY_MS}ms`);
}

// Pre-warm the gRPC/TLS channel so the first real response is fast.
function warmup() {
    debug("STT: warming up gRPC channel");
    prepare();
}

module.exports = { prepare, startAudio, warmup };
