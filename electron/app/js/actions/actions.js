const event = require('js/events/events')
const common = require('js/helpers/common')
const media = require('js/helpers/media')
const responses = require('js/responses/responses')
const speak = require('js/senses/speak')
const debug = require('js/helpers/debug')


async function setAnswer(ans=null, overrides={}){

	// @param {obj} ans - the response object as defined in responses.js
	// @param {obj} overrides - new keys to be added or overriden in ans param
	debug("RESPONSE > START")

	// merge overriden values and new values
	Object.assign(ans, overrides)

	let soundPromise = Promise.resolve()
	if(ans.hasOwnProperty('sound') && ans.sound !== null){
		soundPromise = speak.playSound(ans.sound)
	}

	let q = await common.setQuery(ans)
	debug(`LOCAL FILE OR SEARCH QUERY > ${q}`)

	let r = null

	if(ans.type == 'remote'){
		r = await media.findRemoteGif(q)
		debug(`MEDIA URL > ${r}`)
	} else if(ans.type == 'url'){
		r = ans.url
		debug(`MEDIA URL (direct) > ${r}`)
	} else {
		// local response
		r = q
	}

	let mediaType = await media.findMediaType(r)
	let d = await media.findMediaDuration(r)

	// Enforce minimum display duration for looping media
	if (ans.loop && d) {
		d = Math.max(d, ans.minDuration || 6000)
	}

	debug(`MEDIA DURATION > ${d}`)

	// Play confirmation alert only for non-wakeword responses with no media.
	// Wakeword uses LED + servo as confirmation; GIF/video media is its own confirmation.
	if (!d && ans.type !== 'wakeword') {
		speak.playSound('alert.wav')
	}

	if(ans.hasOwnProperty('led') && Object.keys(ans.led).length != 0){
		// run led animation
		event.emit('led-on', {anim: ans.led.anim , color: ans.led.color })
	}

	if(ans.hasOwnProperty('servo') && ans.servo !== null){
		// move servo
		event.emit('servo-move', ans.servo)
	}

	if(ans.hasOwnProperty('cbBefore')){
		ans.cbBefore()
	}

	// Interruptible (long-form) media keeps the mic live so wakeword still works.
	// A stop-media event (emitted on wakeword) cancels transitionFromMedia early.
	const micWasPaused = !ans.interruptible && !!d
	if(micWasPaused){
		event.emit('mic-pause')
	}

	let showMedia = common.transitionToMedia(d, mediaType, ans.loop || false)

	if(ans.hasOwnProperty('text') && ans.text){
		text.showText(ans.text)
	}

	if(ans.hasOwnProperty('cbDuring')){
		ans.cbDuring()
	}

	// Wait for both the media transition AND the sound to finish before continuing.
	// For the wakeword response (no media, d=null) this means waiting for alert.wav
	// to complete before emitting speech-to-text.
	await Promise.all([common.transitionFromMedia(d, ans.interruptible || false), soundPromise])

	// Stop the video element — it stays hidden but keeps looping audio otherwise.
	if(mediaType === 'video'){
		const video = document.getElementById('video')
		video.pause()
		video.currentTime = 0
		video.loop = false
	}

	if(micWasPaused){
		event.emit('mic-resume')
	}

	if(ans.hasOwnProperty('text')){
		text.removeText()
	}

	debug(`RESPONSE > END`)

	// callback
	if(ans.hasOwnProperty('cbAfter')){
		ans.cbAfter()
	}
}

function wakeword(){
	setAnswer(responses.wakeword, {type:'wakeword'})
}


module.exports = {
	wakeword,
	setAnswer
}