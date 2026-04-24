const spawn = require('child_process').spawn
const os = require('os')
const path = require('path')
const event = require('js/events/events')
const debug = require('js/helpers/debug')

const isARM = os.platform() === 'linux' && (os.arch() === 'arm' || os.arch() === 'arm64')
const tts = isARM ? 'flite' : 'say'

function speak(text){
	// speaks out the given text using the system voice
	// @param {string} text - the text to be spoken
	
	let speechProcess = null

	if(tts === 'flite'){
		speechProcess = spawn(tts, ['-voice','awb','-t',text],{detached:false})

		
	} else if(tts === 'say'){
		speechProcess = spawn(tts, [text], {detached: false})
	}

	speechProcess.on('error', (err) => {
		console.error(`[speak] TTS error (is ${tts} installed?):`, err.message)
	})
	speechProcess.on('close', ()=>{
		event.emit("finished-speaking")
	})
}

function playSound(filename){
	// plays passed in file located in app/media/sounds
	// @param {string} filename - accepts .wav & .mp3 files located in app/media/sounds
	// Returns a Promise that resolves when playback finishes (so callers can await it).
	debug(`FILE: ${filename}`)

	if(!filename.endsWith('.wav') && !filename.endsWith('.mp3')){
		console.error(`File ${filename} is not supported`)
		return Promise.resolve()
	}

	if(isARM){
		// arecord initializes the WM8960 codec (including output routing). Stopping it
		// resets the codec and aplay can't bring it back up — so the mic must stay
		// running while sound plays. plughw handles the sharing; sound files must be
		// 16kHz mono to match the seeed card's clock (same rate as capture).
		const filepath = path.join(process.cwd(),'app','media','sounds',filename)
		// The WM8960 clock is locked to 16kHz while arecord is running, so any
		// wav at a different rate must be resampled first. Pipe through sox.
		return new Promise((resolve) => {
			const cmd = `sox "${filepath}" -r 16000 -c 1 -t wav - | aplay -D plughw:seeed2micvoicec,0`
			const proc = spawn('sh', ['-c', cmd], { detached: false })
			proc.on('error', (err) => { console.error('[speak] aplay error:', err.message); resolve() })
			proc.on('close', resolve)
		})
	} else {
		let audio = document.getElementById("sound")
		audio.currentTime = 0
		audio.src = path.join(process.cwd(),'app','media','sounds',filename)
		return new Promise((resolve) => {
			audio.addEventListener('ended', resolve, { once: true })
			audio.play().catch((err) => { console.error("audio.play() failed:", err); resolve() })
		})
	}
}

function stopSound(){
	// stop sound playback

	let audio = document.getElementById("sound")
	audio.currentTime = 0
	audio.pause()
	audio.src = ''
}

function setVolume(vol){
	// sets volume level for audio and video playback
	// @param {float} vol - range 0-1

	if(vol < 0){
		vol = 0
	} else if(vol > 1){
		vol = 1
	}

	if(isARM){
		// aplay bypasses PulseAudio, so target the WM8960 hardware mixer directly.
		// The WM8960 volume scale is non-linear: ALSA 40% = -70dB (near-silent),
		// ALSA 90% ≈ -7dB (loud). Map our 0–1 range onto the chip's audible region
		// (ALSA value 48 = -73dB min → 127 = +6dB max) so any non-zero vol is heard.
		const card = ['-D', 'hw:seeed2micvoicec']
		const hwValue = vol === 0 ? 0 : Math.round(48 + vol * (127 - 48))
		const pct = Math.round(hwValue / 127 * 100)
		for (const ctl of ['Headphone', 'Speaker']) {
			spawn('amixer', [...card, 'sset', ctl, `${pct}%`], { detached: false })
				.on('error', (err) => console.error(`amixer sset ${ctl} error:`, err))
		}
	}

	const video = document.getElementById("video")
	const audio = document.getElementById("sound")

	video.volume = vol
	audio.volume = vol
}

module.exports = {
	speak,
	playSound,
	stopSound,
	setVolume
}