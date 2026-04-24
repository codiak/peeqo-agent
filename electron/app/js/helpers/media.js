const config = require('config/config.js')
const giphy = require('giphy-api')(config.giphy.key);
const { ipcRenderer } = require('electron');
const { GoogleAuth } = require('google-auth-library');
const path = require('path')

const youtubeAuth = new GoogleAuth({
	keyFilename: path.join(process.cwd(), 'app', 'config', config.speech.dialogflowKey),
	scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
})

async function youtubeGet(url) {
	const client = await youtubeAuth.getClient()
	const token = await client.getAccessToken()
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token.token}` } })
	if (!res.ok) throw new Error(`YouTube API error (${res.status}): ${await res.text()}`)
	return res.json()
}


function findRemoteGif(query){
	if(!query){
		return null
	}

	// search() returns up to 10 results; pick randomly from the top 5 so the same
	// query doesn't always show the same GIF. translate() is deterministic and repetitive.
	return new Promise((resolve, reject)=>{
		giphy.search({ q: query, limit: 10, rating: 'pg-13', lang: 'en', weirdness: 0 }, (err, res)=>{
			if(err || !res?.data?.length){
				reject(`Got error or no results for "${query}" from Giphy`)
				return
			}
			const top = res.data.slice(0, 3)
			const chosen = top[Math.floor(Math.random() * top.length)]
			resolve(chosen.images.original_mp4.mp4)
		})
	})
}

function parseISO8601Duration(iso) {
	const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
	if (!m) return 0
	return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0)
}

async function findRemoteVideo(query, maxDuration = null) {
	const effectiveMax = maxDuration || config.youtube.maxVideoDuration || 30
	const isLongForm = effectiveMax > 60

	// Short clips: sort by view count (popular/mainstream first), exclude Shorts, filter by duration.
	// Long form: sort by relevance (better for specific music/video requests), no duration filter.
	const order = isLongForm ? 'relevance' : 'viewCount'
	let searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(isLongForm ? query : query + ' -shorts')}&type=video&videoEmbeddable=true&maxResults=25&relevanceLanguage=en&regionCode=US&order=${order}`
	if (!isLongForm) searchUrl += '&videoDuration=short'

	const searchData = await youtubeGet(searchUrl)
	if (!searchData.items?.length) return null

	const ids = searchData.items.map(i => i.id.videoId).join(',')
	const firstId = searchData.items[0].id.videoId

	// Fire duration lookup and URL fetch for the first candidate in parallel.
	// The first search result is often the best match; if it passes the duration
	// filter its URL is already resolved before we even finish checking durations.
	const [detailData, firstUrl] = await Promise.all([
		youtubeGet(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}`),
		ipcRenderer.invoke('get-youtube-url', firstId).catch(() => null),
	])

	const valid = detailData.items.filter(v => {
		const secs = parseISO8601Duration(v.contentDetails.duration)
		return secs > 0 && secs <= effectiveMax
	})
	if (!valid.length) return null

	// Use the prefetched URL if the first result passed the duration filter
	if (firstUrl && valid.some(v => v.id === firstId)) return firstUrl

	// Otherwise try remaining valid candidates in random order
	const remaining = valid.filter(v => v.id !== firstId).sort(() => Math.random() - 0.5)
	for (const video of remaining) {
		try {
			const url = await ipcRenderer.invoke('get-youtube-url', video.id)
			if (url) return url
		} catch (err) {
			console.warn(`[media] skipping ${video.id}: ${err.message.split('\n')[0]}`)
		}
	}
	return null
}

async function findMediaType(filepath){

	if(!filepath){
		return null
	}

	// Strip query string before checking extension (YouTube CDN URLs have none)
	const ext = path.extname(filepath.split('?')[0]).toLowerCase()

	if([".png", ".jpg", ".jpeg"].includes(ext)) return "img"
	if([".mp4"].includes(ext)) return "video"
	if([".gif", ".webp"].includes(ext)) return "gif"

	// Extensionless remote URLs (e.g. YouTube CDN) — treat as video
	if(filepath.startsWith('http')) return "video"
}

async function findMediaDuration(path){
	if(!path){
		return null
	}

	let type = await findMediaType(path)

	let duration = 0

	if(type == 'video'){

		duration = await findVideoDuration(path)
		

	} else if(type == 'img'){

		duration = await findGifDuration(path)

	} else if(type == 'gif'){
		
		duration = await findGifDuration(path)
		
	}

	return duration
}

async function findGifDuration(path){

	let gif = document.getElementById("gif")
	gif.src = path
	return 6000
}


async function findVideoDuration(path){

	if(!path){
		return null
	}

	let endPauseDuration = 1200
	let video = document.getElementById("video")
	video.src = path
	video.pause()

	const canplay = await new Promise((resolve, reject) => {
		video.addEventListener('canplay', (e)=>{
			resolve(e.returnValue)
		})
	})

	if(!canplay){
		return 0
	}

	let duration = video.duration*1000+endPauseDuration
	return duration
}


module.exports = {
	findRemoteGif,
	findRemoteVideo,
	findMediaType,
	findMediaDuration
}