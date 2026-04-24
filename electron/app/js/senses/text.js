const event = require('js/events/events')

class Text{
	constructor(){
		this.text = document.getElementById("textOverlay")
		this._bubbleTimer = null

		event.on('show-text', this.showText)
		event.on('remove-text', this.removeText)
	}

	showText(content){
		this.text.innerHTML = content
	}

	removeText(){
		this.text.innerHTML = ''
	}

	showBubble(content){
		if (this._bubbleTimer) {
			clearTimeout(this._bubbleTimer)
			this._bubbleTimer = null
		}
		const el = document.getElementById("speech-bubble")
		el.textContent = content
		el.style.display = "block"
		document.getElementById("eyeWrapper").classList.add("bubble-active")

		// 1.5s per word, min 15s, max 60s
		const wordCount = content.trim().split(/\s+/).length
		this._bubbleTimer = setTimeout(() => this.hideBubble(), Math.min(60000, Math.max(15000, wordCount * 1500)))
	}

	hideBubble(){
		if (this._bubbleTimer) {
			clearTimeout(this._bubbleTimer)
			this._bubbleTimer = null
		}
		document.getElementById("speech-bubble").style.display = "none"
		document.getElementById("eyeWrapper").classList.remove("bubble-active")
	}
}

const text = new Text()

module.exports = text