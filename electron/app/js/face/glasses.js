const path = require('path')
const event = require('js/events/events')
const debug = require('js/helpers/debug')

class Glasses{

	constructor(){
		this.glasses = document.getElementById("glasses")
		this.currentGlass = 0
		this.glassList = ["glass-regular.png","glass-pointy.png","glass-square.png","glass-circle.png","glass-rectangle.png","glass-rayban.png"]

		this.changeGlasses = this.changeGlasses.bind(this)

		event.on('change-glasses', this.changeGlasses)
	}

	changeGlasses(){
		this.currentGlass++

		debug('[glasses] changed to', this.glassList[this.currentGlass])
		if(this.currentGlass == this.glassList.length){
			this.currentGlass = 0
		}

		let imgPath = path.join(process.cwd(),'app','media','imgs','glasses', this.glassList[this.currentGlass])

		this.glasses.src = imgPath
	}


}

module.exports = Glasses