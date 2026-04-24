const event = require('js/events/events')
const os = require('os')
const debug = require('js/helpers/debug')

const isARM = os.platform() === 'linux' && (os.arch() === 'arm' || os.arch() === 'arm64')

function initializeButtons() {
    if (!isARM) return;

    // GPIO events are forwarded from the main process via IPC because rpi-gpio
    // is NAN-based and cannot be loaded in the Electron renderer process.
    const { ipcRenderer } = require('electron')

    const longPressDuration = 3000

    // Per-channel state — avoids interference when multiple buttons fire close together.
    const state = new Map()

    function getState(channel) {
        if (!state.has(channel)) state.set(channel, { pressed: false, timer: null, longPressEventSent: false })
        return state.get(channel)
    }

    ipcRenderer.on('gpio-change', (_, { channel, value }) => {
        const s = getState(channel)

        if (value == false) {
            debug(`Btn ${channel} released`)
            clearTimeout(s.timer)
            s.timer = null
            s.pressed = false

            if (!s.longPressEventSent) {
                event.emit(`btn-${channel}-short-press`)
            }

            s.longPressEventSent = false
        } else if (value == true) {
            debug(`Btn ${channel} pressed`)

            if (!s.pressed) {
                s.timer = setTimeout(() => {
                    event.emit(`btn-${channel}-long-press`)
                    s.longPressEventSent = true
                    s.timer = null
                }, longPressDuration)
            }

            s.pressed = true
        }
    })
}

module.exports = {
    initializeButtons
}
