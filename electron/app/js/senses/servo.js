const os = require('os')
const event = require('js/events/events')

const isARM = os.platform() === 'linux' && (os.arch() === 'arm' || os.arch() === 'arm64')

class Servo {
    constructor() {
        if (isARM) {
            // pca9685 is NAN-based so servo is driven from the main process.
            // Forward event-bus commands to it via IPC.
            this.ipc = require('electron').ipcRenderer
            event.on('servo-move',  (animName) => this.ipc.send('servo-move', animName))
            event.on('servo-reset', ()         => this.ipc.send('servo-reset'))
        }
    }
}

module.exports = Servo
