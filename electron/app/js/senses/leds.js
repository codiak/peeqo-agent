const os = require('os')
const event = require('js/events/events')
const debug = require('js/helpers/debug')

const isARM = os.platform() === 'linux' && (os.arch() === 'arm' || os.arch() === 'arm64')

class Leds {
    constructor() {
        this.playAnimation = this.playAnimation.bind(this)
        this.off = this.off.bind(this)

        if (isARM) {
            // pi-spi is NAN-based so the LED strip is driven from the main
            // process. Forward event-bus commands to it via IPC.
            this.ipc = require('electron').ipcRenderer
            event.on('led-on',  this.playAnimation)
            event.on('led-off', this.off)
        }
    }

    playAnimation(anim) {
        debug(`LED anim: ${anim.anim} with color ${anim.color}`)
        this.ipc.send('led-on', anim)
    }

    off() {
        this.ipc.send('led-off')
    }
}

const leds = new Leds()
Object.freeze(leds)
module.exports = leds
