"use strict";

// Servo driver (PCA9685 via I2C) runs in the main process because pca9685
// is NAN-based and cannot be loaded in the Electron renderer on Electron 14+.
// The renderer sends 'servo-move' / 'servo-reset' IPC messages; this module
// handles I2C writes and animation playback.

const { ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const debug = require("./app/js/helpers/debug");

const PLAYBACK_RATE_MS = 33;
const REST_PULSE_US = 1500;
const ANIM_DIR = path.join(__dirname, "app", "media", "servo_anims");

let pwm = null;
let servoTimer = null;

function setup() {
    let i2cBus, PCA9685;
    try {
        i2cBus = require("i2c-bus");
        PCA9685 = require("pca9685").Pca9685Driver;
    } catch (err) {
        console.error("[servo-main] failed to load pca9685 / i2c-bus:", err.message);
        return;
    }

    try {
        const options = {
            i2c: i2cBus.openSync(1),
            address: 0x40,
            frequency: 50,
            debug: false,
        };
        pwm = new PCA9685(options, (err) => {
            if (err) {
                console.error("[servo-main] PCA9685 init error:", err);
                pwm = null;
                return;
            }
            for (let i = 0; i < 3; i++) pwm.setPulseLength(i, REST_PULSE_US);
            debug("[servo-main] PCA9685 ready");
        });
    } catch (err) {
        console.error("[servo-main] failed to open I2C bus:", err.message);
        return;
    }

    ipcMain.on("servo-move",  (_, animName) => animate(animName));
    ipcMain.on("servo-reset", ()            => reset());
}

function reset() {
    if (servoTimer !== null) {
        clearInterval(servoTimer);
        servoTimer = null;
    }
    if (!pwm) return;
    for (let i = 0; i < 3; i++) pwm.setPulseLength(i, REST_PULSE_US);
}

function animate(animName) {
    if (!pwm) { console.warn("[servo-main] no PCA9685 — skipping animation"); return; }

    debug(`[servo-main] loading animation: ${animName}`);
    const filepath = path.join(ANIM_DIR, `${animName}.json`);

    fs.readFile(filepath, "utf8", (err, contents) => {
        if (err) { console.error("[servo-main] error reading anim file:", err.message); return; }

        let data;
        try { data = JSON.parse(contents); }
        catch (e) { console.error("[servo-main] JSON parse error:", e.message); return; }

        // Cancel any in-progress animation before starting the new one
        reset();

        let index = 0;
        servoTimer = setInterval(() => {
            for (let i = 0; i < 3; i++) pwm.setPulseLength(i, data[index][i]);
            index++;
            if (index >= data.length) {
                debug(`[servo-main] finished animation: ${animName}`);
                clearInterval(servoTimer);
                servoTimer = null;
                reset();
            }
        }, PLAYBACK_RATE_MS);
    });
}

module.exports = { setup };
