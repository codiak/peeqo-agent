const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const event = require('js/events/events')
const debug = require('js/helpers/debug')

const PORT = 8765
const isARM = os.platform() === 'linux' && (os.arch() === 'arm' || os.arch() === 'arm64')
const CAMERA_SERVER = path.join(process.cwd(), '..', 'python', 'camera_server.py')

class Camera {
    constructor() {
        this.proc = null
        this.ready = false
        this.streaming = false

        if (isARM) this._spawnServer()

        event.on('camera-on',    () => this.startCamera())
        event.on('camera-off',   () => this.stopCamera())
        event.on('camera-photo', () => this.takePhoto())
    }

    _spawnServer() {
        this.proc = spawn('python3', [CAMERA_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })

        this.proc.stdout.on('data', (data) => {
            for (const line of data.toString().trim().split('\n')) {
                if (line === 'ready') {
                    this.ready = true
                    debug('[camera] server ready')
                } else if (line.startsWith('snapshot:')) {
                    const filepath = line.slice(9)
                    if (filepath !== 'error') {
                        document.getElementById('pictureCapture').src = `file://${filepath}?t=${Date.now()}`
                        event.emit('show-div', 'pictureWrapper')
                        setTimeout(() => {
                            event.emit('show-div', this.streaming ? 'cameraWrapper' : 'eyeWrapper')
                        }, 4000)
                    } else {
                        console.warn('[camera] snapshot failed — no frame available yet')
                    }
                }
            }
        })

        this.proc.stderr.on('data', (d) => debug('[camera]', d.toString().trim()))
        this.proc.on('exit', (code) => {
            console.warn(`[camera] server exited (code ${code})`)
            this.ready = false
        })
    }

    _send(cmd) {
        if (!this.proc || !this.ready) { console.warn(`[camera] not ready — ignoring: ${cmd}`); return }
        this.proc.stdin.write(cmd + '\n')
    }

    startCamera() {
        if (!isARM) { debug('[camera] not on ARM — camera server only runs on Pi'); return }
        this._send('start')
        this.streaming = true
        document.getElementById('cameraFeed').src = `http://localhost:${PORT}/stream?t=${Date.now()}`
        event.emit('show-div', 'cameraWrapper')
        debug('[camera] started')
    }

    stopCamera() {
        this._send('stop')
        this.streaming = false
        document.getElementById('cameraFeed').src = ''
        event.emit('show-div', 'eyeWrapper')
        debug('[camera] stopped')
    }

    takePhoto() {
        if (!this.streaming) {
            this.startCamera()
            // Give the camera a moment to produce its first frame before snapping
            setTimeout(() => this._send('snapshot'), 1000)
            return
        }
        this._send('snapshot')
    }
}

module.exports = Camera
