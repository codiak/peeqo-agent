const event = require('js/events/events')
const action = require('js/actions/actions')
const debug = require('js/helpers/debug')
const common = require('js/helpers/common')
const power = require('js/power/power')
const speak = require('js/senses/speak')
const stt = require('js/intent-engines/stt')
const claude = require('js/intent-engines/claude')
const text = require('js/senses/text')
const mic = require('js/senses/mic')

module.exports = () => {

	// Tracks whether a long-form video was paused by the wakeword.
	// Cleared by final-transcript (command heard) or end-speech-to-text (nothing heard).
	let mediaWasPaused = false

	// STATUS INDICATORS (upper-right corner)
	const recEl = document.getElementById('status-recording')
	const loadEl = document.getElementById('status-loading')

	event.on('status-listening', () => { recEl.className = 'active' })
	event.on('wakeword',         () => { recEl.className = '' })

	event.on('final-transcript', () => {
		debug('[indicator] final-transcript fired → loading')
		loadEl.className = 'active'
	})
	event.on('show-div', (id) => {
		if (id === 'videoWrapper' || id === 'gifWrapper') loadEl.className = ''
	})
	event.on('status-listening', () => { loadEl.className = '' })

	event.on('wakeword', () => debug("[listeners] wakeword event received"))
	// Pause any interruptible long-form media — will resume if no command is spoken
	event.on('wakeword', () => { mediaWasPaused = true; event.emit('pause-media') })
	event.on('wakeword', () => text.hideBubble())
	event.on('wakeword', action.wakeword)
	// Open gRPC connection immediately so it's warm when audio starts
	event.on('wakeword', stt.prepare)
	// Emit speech-to-text at wakeword time (parallel to alert playback).
	// AUDIO_START_DELAY_MS in dialogflow.js is the single knob for the full
	// wakeword-to-Dialogflow gap. It must cover alert.wav duration + room echo.
	// Previously speech-to-text fired from cbAfter (after alert ended), making
	// the total delay = alert_duration + AUDIO_START_DELAY_MS. Now it's just
	// AUDIO_START_DELAY_MS, and the alert plays concurrently.
	event.on('wakeword', () => event.emit('speech-to-text'))

	// A command was spoken — stop the paused media so the new response can take over
	event.on('final-transcript', () => {
		if (mediaWasPaused) { mediaWasPaused = false; event.emit('stop-media') }
	})
	event.on('final-transcript', claude.handleTranscript)

	event.on('show-speech-bubble', (msg) => text.showBubble(msg))

	event.on('no-command', () => {
		event.emit("led-on", {anim:'fadeOutError',color:'red'})
	})

	event.on('speech-to-text', () => debug("[listeners] speech-to-text event received"))
	event.on('speech-to-text', stt.startAudio)

	event.on('end-speech-to-text', () =>{

		if(process.env.OS == "unsupported"){
			document.getElementById("wakeword").style.backgroundColor = ""
		}

		if (mediaWasPaused) {
			// Nothing was heard — resume the video that was paused on wakeword
			mediaWasPaused = false
			event.emit('resume-media')
		}

		// Restart arecord to get a clean stream before re-attaching the wakeword
		// detector. Without this, audio buffered during the Dialogflow session
		// (including any alert echo) flushes into the detector immediately on
		// re-pipe and can cause a spurious re-trigger.
		event.emit('mic-pause')
		event.emit('mic-resume')  // mic-resume internally emits pipe-to-wakeword

	})

	// passes id of div to show
	event.on('show-div', common.showDiv)


	// POWER CONTROL
	event.on('shutdown', power.shutdown)

	event.on('reboot', power.reboot)

	event.on('refresh', power.refresh)


	// MIC MUTE DURING MEDIA PLAYBACK
	event.on('mic-pause', () => mic.pause())
	event.on('mic-resume', () => {
		mic.resume()
		// Re-pipe the resumed mic to the wakeword detector.
		// mic-resume starts a new arecord process; without this the detector
		// would have no audio after the response media finishes.
		event.emit('pipe-to-wakeword')
	})

	// AUDIO PLAYBACK
	event.on('play-sound', speak.playSound)

	event.on('set-volume', speak.setVolume)

	// BUTTON PRESSES
	// btn-16 = "back right": short = reload renderer, long = shutdown Pi
	event.on('btn-16-short-press', () => {
		debug('[btn] 16 short press → refresh')
		power.refresh()
	})
	event.on('btn-16-long-press', () => {
		debug('[btn] 16 long press → shutdown')
		power.shutdown()
	})

	// btn-4, btn-17, btn-23: unassigned — add behaviour here
	event.on('btn-4-short-press',  () => {})
	event.on('btn-4-long-press',   () => {})
	event.on('btn-17-short-press', () => {})
	event.on('btn-17-long-press',  () => {})
	event.on('btn-23-short-press', () => {})
	event.on('btn-23-long-press',  () => {})

}