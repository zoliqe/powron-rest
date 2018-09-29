//import { * as express } from 'expres';

const port = 8088
const tokens = ['OM4AA-1999', 'OM3RRC-1969']
const authTimeout = 60 // sec
const heartbeat = 1 // sec
const actionByState = state => (state && 'on') || 'off'
const serviceRelays = {'SDR': ['0'], 'TCVR': ['0', '1']}
const services = Object.keys(serviceRelays)
const tcvrUrl = 'tcvr'
const tcvrDev = '/dev/ttyUSB0'
const tcvrBaudrate = 9600
const tcvrCivAddr = 0x44
const myCivAddr = 224
const uartDev = '/dev/ttyAMA0'
const uartBaudrate = 115200

const express = require('express')
const SerialPort = require('serialport')
const temps = require('ds18b20-raspi')
const mic = require('mic')

const tokenParam = 'token'
const serviceParam = 'service'
const serviceURL = `/:${tokenParam}/:${serviceParam}/`
const freqParam = 'freq'

let whoNow = null
let serviceNow = false
let authTime = null // sec
const secondsNow = () => Date.now() / 1000
let audio = undefined

function executeAction(req, res, state) {
	const token = req.params[tokenParam] && req.params[tokenParam].toUpperCase()
	const service = req.params[serviceParam] && req.params[serviceParam].toUpperCase()

	const authorized = authorize(token) || error(res, 'EAUTH')
	const result = authorized && (manageService(service, actionByState(state)) || error(res, 'ESERV'))

	if (result) {
		serviceNow = state && service
		if (!state) whoNow = authTime = null // logout
		res.send('OK')
		res.locals.result = 'OK'
	}
	log(`..authored ${whoIn(token)} for ${service} state ${state}, result: ${res.locals.result}`)
	return result
}

function error(res, err) {
	res.locals.result = err
	res.status(500).send(err)
	return false
}

function authorize(token) {
	const who = whoIn(token)
	if (!token || !who) return false
	if (!tokens.includes(token) || (whoNow && whoNow !== who)) return false

	whoNow = who
	authTime = secondsNow()
	return true
}

function whoIn(token) {
	if (!token) return null
	const delPos = token.indexOf('-')
	return delPos > 3 ? token.substring(0, delPos).toUpperCase() : null
}

function manageService(service, action) {
	if (!service || !services.includes(service)) return false
	if (serviceNow && serviceNow !== service) return false

	let i = 0
	serviceRelays[service].forEach(relay => setTimeout(() => sendCmd(action + relay), i++ * 5000))
	return true
}

function checkAuthTimeout() {
	if (!whoNow) return

	if (!authTime || (authTime + authTimeout) < secondsNow()) {
		log(`auth timeout for ${whoNow}:`)
		whoNow = authTime = null
		stopService()
	}
}

function stopService() {
	if (!serviceNow) return
	manageService(serviceNow, actionByState(false))
	serviceNow = false
}

function log(str) {
	console.log(new Date().toISOString() + ' ' + str)
}

log('Starting express app')
const app = express()
app.get('/', function (req, res) {
	res.send('Hello World')
})

log('Registering REST services')
register(serviceURL + 'start', (req, res) => executeAction(req, res, true))
register(serviceURL + 'stop', (req, res) => executeAction(req, res, false))
register('/temps', (req, res) => res.send(temps.readAllC()))
register('/status', (req, res) => res.send({ who: whoNow, service: serviceNow, authTime: authTime }))
register(`/${tcvrUrl}/freq/:${freqParam}`, tcvrFreq)
register('/rx.wav', audioStream)

log(`Listening on ${port}`)
app.listen(port)

log(`Activating heartbeat every ${heartbeat} s`)
setInterval(checkAuthTimeout, heartbeat * 1000)

log(`Opening UART ${uartDev}`)
const uart = new SerialPort(uartDev,
	{ baudRate: uartBaudrate },
	(err) => err && log(`UART ${err.message}`))
uart.on('open', () => log(`UART opened: ${uartDev} ${uartBaudrate}`))
uart.on('data', (data) => log(`UART => ${data}`))

log(`Opening TCVR CAT ${tcvrDev}`)
const tcvr = new SerialPort(tcvrDev, { baudRate: tcvrBaudrate },
	(err) => err && log(`TCVR ${err.message}`))
tcvr.on('open', () => log(`TCVR opened: ${tcvrDev} ${tcvrBaudrate}`))
tcvr.on('data', (data) => log(`TCVR => ${data}`))

function register(url, callback) {
	log(`URL: ${url}`)
	app.get(url, callback)
}

function sendCmd(cmd) {
	log(`UART <= ${cmd}`)
	uart.write(cmd, (err) => err && log(`UART ${err.message}`))
}

function tcvrFreq(req, res) {
	let f = req.params[freqParam] && Number(req.params[freqParam]).toFixed(0)
	if (!f || f < 1500000 || f > 30000000) return error(res, 'EVAL')

	const hex2dec = (h) => {
		const s = Math.floor(h / 10)
		return s * 16 + (h - s * 10)
	}
	// log(`f=${f}`)
	const mhz10_1 = Math.floor(f / 1000000) // 10MHz, 1MHz
	f = f - (mhz10_1 * 1000000)
	// log(`f=${f}`)
	const khz100_10 = Math.floor(f / 10000) // 100kHz, 10kHz
	f = f - (khz100_10 * 10000)
	// log(`f=${f}`)
	const hz1000_100 = Math.floor(f / 100) // 1kHz, 100Hz
	f = f - (hz1000_100 * 100)
	// log(`f=${f}`)
	const hz10 = Math.floor(f / 10) * 10 // 10Hz

	const data = [254, 254, // 0xFE 0xFE
		tcvrCivAddr, myCivAddr, 0, // 0: transfer Freq CMD w/o reply .. 5: set Freq CMD with reply
		hex2dec(hz10), hex2dec(hz1000_100), hex2dec(khz100_10), hex2dec(mhz10_1), 0, // freq always < 100MHz
		253] // 0xFD
	log(`TCVR f: ${data}`)
	tcvr.write(data, (err) => err && log(`TCVR ${err.message}`))
	res.send('OK')
}

function audioStream(req, res) {
	res.set({ 'Content-Type': 'audio/wav', 'Transfer-Encoding': 'chunked' })
	audio && stopAudio() // stop previously started audio
	startAudio(stream => stream.pipe(res))
}

async function startAudio(cb) {
  log('start audio')
  await sleep(1000)
  audio = mic({
    device: 'plughw:1,0',
    rate: '8000',
    channels: '1',
    fileType: 'wav',
    debug: true,
    // exitOnSilence: 6
  })

  // audioStream = audio.getAudioStream();
  audio.getAudioStream().on('startComplete', () => {
    // console.log('startComplete');
    cb(audio.getAudioStream())
  })

  audio.start()
}

function stopAudio(cb) {
  log('stop audio');
  audio.stop()
  // audio.getAudioStream().on('stopComplete', () => {
    // audioStream = undefined;
    audio = undefined
    // cb()
  // })
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}
