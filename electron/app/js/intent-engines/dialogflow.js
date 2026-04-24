const { SessionsClient } = require("@google-cloud/dialogflow").v2;
const path = require("path");
const uuid = require("uuid");
const mic = require("js/senses/mic");
const event = require("js/events/events");
const through2 = require("through2");
const config = require("config/config");
const debug = require("js/helpers/debug");

// Delay between speech-to-text signal and actually piping audio.
// Lets the alert sound echo clear before Dialogflow's VAD starts listening.
// Tune via config.speech.audioStartDelayMs (default 100ms).
// Too low → alert echo may confuse STT. Too high → user's command is missed.
const AUDIO_START_DELAY_MS = config.speech.audioStartDelayMs ?? 100;

// Single shared client — keeps the gRPC/TLS channel alive across sessions so
// only the first open() pays the ~5s TLS handshake cost.
const sessionClient = new SessionsClient({
    keyFilename: path.join(
        process.cwd(),
        "app",
        "config",
        config.speech.dialogflowKey,
    ),
    apiEndpoint: "dialogflow.googleapis.com",
    fallback: false,
});

function buildSessionRequest() {
    const sessionPath = sessionClient.projectAgentSessionPath(
        config.speech.projectId,
        uuid.v4(),
    );
    return {
        session: sessionPath,
        queryInput: {
            audioConfig: {
                audioEncoding: "AUDIO_ENCODING_LINEAR_16",
                sampleRateHertz: 16000,
                languageCode: config.speech.language,
            },
        },
        singleUtterance: true,
        interimResults: false,
    };
}

class DialogflowStream {
    constructor(client, request) {
        this.client = client;
        this.request = request;
        this.stream = this.client.streamingDetectIntent();
        this.intentData = null;
        this.audioTimer = null;
    }

    // Phase 1: open the gRPC stream and write the config frame.
    // Called immediately on wakeword so the connection is ready before audio starts.
    prepare() {
        this.stream
            .on("data", this.handleData.bind(this))
            .on("error", this.handleError.bind(this))
            .once("close", this.handleClose.bind(this));
        this.stream.write(this.request);
    }

    // Phase 2: pipe mic audio after a short delay to let the alert sound clear.
    // Called when speech-to-text fires (after the alert animation finishes).
    startAudio() {
        this.audioTimer = setTimeout(() => {
            const micStream = mic.getMic();
            if (micStream) {
                let byteCount = 0;
                micStream.on("data", (chunk) => {
                    byteCount += chunk.length;
                    if (byteCount === chunk.length) {
                        debug("Dialogflow: first audio chunk received, bytes:", chunk.length);
                    }
                });
                micStream.pipe(this.audioTransform()).pipe(this.stream);
            } else {
                console.error("Failed to get microphone stream.");
            }
        }, AUDIO_START_DELAY_MS);
    }

    audioTransform() {
        return through2.obj((chunk, _, callback) => {
            callback(null, { inputAudio: chunk });
        });
    }

    handleData(data) {
        if (!data.queryResult) return;

        const { queryResult } = data;
        this.intentData = {
            intent: queryResult.intent?.displayName || "No intent matched",
            params: queryResult.parameters?.fields || {},
            queryText: queryResult.queryText,
            responseText: queryResult.fulfillmentText,
        };

        this.stream.end();

        // Unpipe mic so the ended gRPC stream can close cleanly.
        mic.pause();

        if (this.intentData.intent) {
            event.emit("final-command", this.intentData);
        } else {
            event.emit("no-command");
        }

        // Trigger cleanup immediately after dispatching the intent rather than
        // waiting for the gRPC stream's close event (handleClose). The close event
        // can be delayed or never fire — particularly for intents like changeGlasses
        // that skip setAnswer() entirely, leaving detected=true in listen.js and
        // permanently blocking future wakeword events.
        this._sttFired = true;
        event.emit("end-speech-to-text");
    }

    handleError(err) {
        console.error("An error occurred with Dialogflow:", err);
        this.stream.end();
    }

    handleClose() {
        debug("Dialogflow stream closed");
        this.cleanUp();
        // If this stream timed out before startAudio() was called (e.g. warmup stream),
        // clear the module-level reference so the next prepare() can open a fresh one.
        if (pendingStream === this) pendingStream = null;
        // Only emit if handleData didn't already — avoids a second mic-pause/resume
        // cycle that could interrupt a new session that started in the meantime.
        if (!this._sttFired) {
            event.emit("end-speech-to-text");
        }
    }

    cleanUp() {
        if (this.audioTimer) {
            clearTimeout(this.audioTimer);
            this.audioTimer = null;
        }
        this.intentData = null;
    }
}

// Module-level pending stream — created on wakeword (or warmup), consumed on speech-to-text.
let pendingStream = null;

function prepareDialogflow() {
    if (pendingStream) {
        console.warn("Dialogflow: prepare() called while a session is already pending, ignoring");
        return;
    }
    const dialogflowRequest = buildSessionRequest();
    pendingStream = new DialogflowStream(sessionClient, dialogflowRequest);
    pendingStream.prepare();
    debug("Dialogflow: gRPC stream opened, waiting for audio signal");
}

// Pre-warm the gRPC/TLS channel so the first real wakeword response is fast.
// Call once at app startup. The stream will be reused on the first wakeword trigger,
// or discarded when Dialogflow's streaming timeout fires (safe — triggers mic restart).
function warmup() {
    debug("Dialogflow: warming up gRPC channel");
    prepareDialogflow();
}

function startAudio() {
    if (!pendingStream) {
        console.error("Dialogflow: startAudio() called but no pending stream — was prepare() called?");
        return;
    }
    const stream = pendingStream;
    pendingStream = null;
    stream.startAudio();
    debug(`Dialogflow: piping audio in ${AUDIO_START_DELAY_MS}ms`);
}

module.exports = {
    prepare: prepareDialogflow,
    startAudio,
    warmup,
};
