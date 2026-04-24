const path = require('path')
const fs = require('fs')
const event = require('js/events/events')
const actions = require('js/actions/actions')
const responses = require('js/responses/responses')
const weather = require('js/skills/weather')
const Timer = require('js/skills/timer')

const MEMORIES_DIR = path.join(process.cwd(), 'app', 'memories')
const debug = require('js/helpers/debug')

// ---------------------------------------------------------------------------
// Skills — callable by the Claude agent loop as tool implementations.
// Each function maps 1:1 to a tool defined in claude.js.
// ---------------------------------------------------------------------------

function changeGlasses()       { event.emit('change-glasses') }
function confused()            { actions.setAnswer(responses.confused, { type: 'local' }) }
function cameraOn()            { event.emit('camera-on') }
function cameraOff()           { event.emit('camera-off') }
function takePhoto()           { event.emit('camera-photo') }

function getWeather({ city } = {}) {
    return weather.getWeather(city || '')
}

function setTimer({ amount, unit }) {
    const timer = new Timer(amount, unit)
    timer.startTimer()
}

const WEB_DISPLAY_MS = 8000

function showWebPage({ url }) {
    event.emit('show-web-page', url)
    setTimeout(() => event.emit('show-div', 'eyeWrapper'), WEB_DISPLAY_MS)
}

function saveMemory({ key, content }) {
    try {
        if (!fs.existsSync(MEMORIES_DIR)) fs.mkdirSync(MEMORIES_DIR, { recursive: true })
        const safe = key.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64)
        fs.writeFileSync(path.join(MEMORIES_DIR, `${safe}.md`), content.trim() + '\n')
        debug(`[skills] memory saved: ${safe}`)
        return { saved: true }
    } catch (err) {
        console.error('[skills] saveMemory error:', err.message)
        return { saved: false, error: err.message }
    }
}

module.exports = { changeGlasses, confused, getWeather, setTimer, cameraOn, cameraOff, takePhoto, showWebPage, saveMemory }
