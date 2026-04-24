const config = require('config/config')
const debug = require('js/helpers/debug')

async function getWeather(city) {
	if (!city) city = config.openweather.city;

	const query = encodeURI(city);
	const response = await fetch(`http://api.openweathermap.org/data/2.5/weather?q=${query}&units=imperial&APPID=${config.openweather.key}`);
	const json = await response.json();

	debug('[weather]', JSON.stringify(json));
	if (json.cod == '404') {
		console.error(`Can't find city ${query}`);
		return null;
	}

	return {
		city: json.name,
		temp: Math.round(json.main.temp),
		description: json.weather[0].description,
	};
}

module.exports = { getWeather }