"use strict";

// LED strip (DotStar/APA102 via SPI) is driven from the main process because
// pi-spi is NAN-based and cannot be loaded in the Electron renderer process.
// The renderer sends 'led-on' / 'led-off' IPC messages; this module handles
// all animation state and SPI writes.

const { ipcMain } = require("electron");
const debug = require("./app/js/helpers/debug");

const LENGTH = 12;
const TRAIL_LENGTH = 3;

const COLORS = {
    red:    [255, 0,   0  ],
    green:  [0,   255, 0  ],
    blue:   [0,   0,   255],
    aqua:   [0,   255, 255],
    purple: [190, 64,  242],
    orange: [239, 75,  36 ],
    yellow: [255, 215, 18 ],
    pink:   [244, 52,  239],
    black:  [0,   0,   0  ],
};

let strip = null;

function setup() {
    let SPI, dotstar;
    try {
        SPI = require("pi-spi");
        dotstar = require("./app/js/lib/dotstar");
    } catch (err) {
        console.error("Failed to initialize LED strip:", err);
        return;
    }

    try {
        const spi = SPI.initialize("/dev/spidev0.0");
        strip = new dotstar.Dotstar(spi, { length: LENGTH });
    } catch (err) {
        console.error("Failed to open SPI device for LEDs:", err);
        return;
    }

    ipcMain.on("led-on",  (_, anim) => playAnimation(anim));
    ipcMain.on("led-off", ()        => off());
}

function playAnimation(anim) {
    debug(`LED anim: ${anim.anim} with color ${anim.color}`);
    const fn = { blink, circle, circleOut, fadeOutError }[anim.anim];
    if (fn) fn(anim.color);
}

function blink(color = "red", time = 500, count = 5, brightness = 0.5) {
    let blinkCount = 0;
    const iv = setInterval(() => {
        blinkCount % 2 === 0 ? on(color, brightness) : off();
        if (++blinkCount > count) clearInterval(iv);
    }, time);
}

function circle(color = "aqua") {
    trail(color, 0,  5);
    trail(color, 11, 6);
    setTimeout(() => {
        trail(color, 5,  0,  false);
        trail(color, 6,  11, false);
    }, 1000);
    setTimeout(() => off(), 2500);
}

function circleOut(color = "green") {
    trail(color, 0,  5);
    trail(color, 11, 6);
}

function trail(color, start, finish, overshoot = true, brightness = 0.5, time = 100, trLen = TRAIL_LENGTH) {
    if (start < 0 || finish < 0 || start > LENGTH || finish > LENGTH) {
        console.error(`LED values outside range 0-${LENGTH}`);
        return;
    }
    let firstLed = start;
    let currentlyOn = [];
    const iv = setInterval(() => {
        currentlyOn.push(firstLed);
        if (currentlyOn.length > trLen) {
            strip.set(currentlyOn.shift(), ...COLORS.black, 0);
        }
        for (const i of currentlyOn) strip.set(i, ...COLORS[color], brightness);
        strip.sync();

        if (start < finish) {
            if (++firstLed > finish) { clearInterval(iv); if (overshoot) clearLedTrail([...currentlyOn], time); }
        } else {
            if (--firstLed < finish) { clearInterval(iv); if (overshoot) clearLedTrail([...currentlyOn], time); }
        }
    }, time);
}

function fadeOutError(color = "red", time = 100) {
    let brightness = 0.5;
    on(color, brightness);
    const iv = setInterval(() => {
        strip.all(...COLORS[color], brightness);
        strip.sync();
        brightness -= 0.1;
        if (brightness < 0) { clearInterval(iv); strip.clear(); strip.sync(); }
    }, time);
}

function clearLedTrail(onLeds, time = 100) {
    const iv = setInterval(() => {
        if (onLeds.length) strip.set(onLeds.shift(), ...COLORS.black, 0);
        else               { clearInterval(iv); strip.clear(); }
        strip.sync();
    }, time);
}

function on(color, brightness = 0.5) {
    if (!COLORS[color]) { console.error(`Unknown LED color: ${color}`); return; }
    strip.all(...COLORS[color], brightness);
    strip.sync();
}

function off() {
    strip.clear();
    strip.sync();
}

module.exports = { setup };
