const Logger = require('logdna')

const options = {
  app: 'worker-server',
  host: process.env.HOST,
}

const logger = Logger.createLogger(process.env.LOGDNA_KEY, options)

module.exports = { logger }
