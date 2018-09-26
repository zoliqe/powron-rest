//import { * as express } from 'expres';

const port = 8088
const tokens = ['OM4AA-1999', 'OM3RRC-1969']
const authTimeout = 60 // sec
const heartbeat = 1 // sec
const actionByState = state => (state && 'on') || 'off'
const serviceRelays = {'SDR': ['0'], 'TCVR': ['0', '1']}
const services = Object.keys(serviceRelays)
const uartDev = '/dev/ttyAMA0'
const uartBaudrate = 115200

const express = require('express')
const SerialPort = require('serialport')
const temps = require('ds18b20-raspi')

const tokenParam = 'token'
const serviceParam = 'service'
const serviceURL = `/:${tokenParam}/:${serviceParam}/`

let whoNow = null
let serviceNow = false
let authTime = null // sec
const secondsNow = () => Date.now() / 1000

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

	serviceRelays[service].forEach(relay => sendCmd(action + relay))
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
app.get(serviceURL + 'start', (req, res) => executeAction(req, res, true))
app.get(serviceURL + 'stop', (req, res) => executeAction(req, res, false))
app.get('/temps', (req, res) => res.send(temps.readAllC()))
app.get('/status', (req, res) => res.send({ who: whoNow, service: serviceNow, authTime: authTime }))

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

function sendCmd(cmd) {
	log(`UART <= ${cmd}`)
	uart.write(cmd, (err) => err && log(`UART ${err.message}`))
}

