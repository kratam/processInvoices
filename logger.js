const Logger = require('logdna')

const options = {
  app: 'worker-server',
}

const logger = Logger.createLogger(process.env.LOGDNA_KEY, options)

module.exports = { logger }
