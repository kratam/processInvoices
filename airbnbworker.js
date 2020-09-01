require('dotenv').config()
const Bull = require('bull')
const { AirbnbService } = require('./airbnb')
const Fiber = require('fibers')
const { makeCompatible } = require('meteor-promise')
const { logger } = require('./logger')

makeCompatible(Promise, Fiber)

const queue = new Bull('airbnb-worker', {
  redis: {
    port: process.env.BULL_PORT || 6379,
    host: process.env.BULL_HOST,
    password: process.env.BULL_PW,
    db: process.env.BULL_DB || 1,
  },
})

const meteorQueue = new Bull('meteor', {
  redis: {
    port: process.env.BULL_PORT || 6379,
    host: process.env.BULL_HOST,
    password: process.env.BULL_PW,
    db: process.env.BULL_DB || 1,
  },
})

const concurrency = Number(process.env.CONCURRENCY || 5)

const throwIfError = (maybeError) => {
  if (maybeError instanceof Error) throw maybeError
}

queue.process('getThreads', concurrency, function (job) {
  logger.log(`running getThreads job ${job.id}`)
  const { encryptedToken, lastMessageAt, ...rest } = job.data
  const airbnb = new AirbnbService({ token: encryptedToken })
  const threadsGenerator = airbnb.getThreadsGenerator({
    lastMessageAt: lastMessageAt ? new Date(lastMessageAt) : null,
    ...rest,
  })
  for (const threads of threadsGenerator) {
    try {
      throwIfError(threads)
      const job = Promise.await(
        meteorQueue.add(
          'receivedAirbnbThreads',
          { threads, lastMessageAt, ...rest },
          {
            removeOnComplete: true,
          },
        ),
      )
      logger.log(
        `Added job meteor.receivedAirbnbThreads ${job.id} (count: ${threads.length})`,
        { threadIds: threads.map((thread) => thread.id) },
      )
    } catch (error) {
      meteorQueue.add(
        'receivedAirbnbError',
        {
          ...rest,
          error: JSON.stringify(error, getCircularReplacer()),
          method: 'getThreads',
        },
        {
          removeOnComplete: true,
        },
      )
    }
  }
})

queue.process('getReservations', concurrency, function (job) {
  logger.log(`running getReservations job ${job.id}`)
  const { listingId, encryptedToken, ...rest } = job.data
  const airbnb = new AirbnbService({ token: encryptedToken })
  const reservationsGenerator = airbnb.getReservationsGenerator({
    listingId,
    limit: 5,
  })
  for (const reservations of reservationsGenerator) {
    try {
      // the generator threw an error
      throwIfError(reservations)
      const job = Promise.await(
        meteorQueue.add(
          'receivedAirbnbReservations',
          { reservations, ...rest },
          {
            removeOnComplete: true,
          },
        ),
      )
      logger.log(
        `Added job meteor.receivedAirbnbReservations ${job.id} (count: ${reservations.length})`,
        { reservationIds: reservations.map((r) => r.id), ...rest },
      )
    } catch (error) {
      meteorQueue.add(
        'receivedAirbnbError',
        {
          ...rest,
          error: JSON.stringify(error, getCircularReplacer()),
          method: 'getReservations',
          listingId,
        },
        {
          removeOnComplete: true,
        },
      )
    }
  }
})

const getCircularReplacer = () => {
  const seen = new WeakSet()
  return (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return
      }
      seen.add(value)
    }
    return value
  }
}

logger.log('airbnbworker waiting for jobs...')
