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

queue.process('getThreads', concurrency, function (job) {
  logger.log(`running getThreads job ${job.id}`)
  const { companyId, hostId, tokens, lastMessageAt, ...rest } = job.data
  const airbnb = new AirbnbService({ token: tokens[0] })
  const threadsGenerator = airbnb.getThreadsGenerator({
    lastMessageAt: lastMessageAt ? new Date(lastMessageAt) : null,
    ...rest,
  })
  for (const threads of threadsGenerator) {
    const job = Promise.await(
      meteorQueue.add(
        'receivedAirbnbThreads',
        { threads, companyId, hostId },
        {
          removeOnComplete: true,
        },
      ),
    )
    logger.log(
      `Added job meteor.receivedAirbnbThreads ${job.id} (count: ${threads.length}, hostId: ${hostId}, companyId: ${companyId})`,
      { threadIds: threads.map((thread) => thread.id) },
    )
  }
})

queue.process('getReservations', concurrency, function (job) {
  logger.log(`running getReservations job ${job.id}`)
  const { apartmentId, listingId, encryptedToken } = job.data
  const airbnb = new AirbnbService({ token: encryptedToken })
  const reservationsGenerator = airbnb.getReservationsGenerator({
    listingId,
    limit: 5,
  })
  for (const reservations of reservationsGenerator) {
    try {
      // the generator threw an error
      if (reservations instanceof Error) throw reservations
      const job = Promise.await(
        meteorQueue.add(
          'receivedAirbnbReservations',
          { reservations, apartmentId },
          {
            removeOnComplete: true,
          },
        ),
      )
      logger.log(
        `Added job meteor.receivedAirbnbReservations ${job.id} (count: ${reservations.length}, apartmentId: ${apartmentId})`,
        { reservationIds: reservations.map((r) => r.id) },
      )
    } catch (error) {
      meteorQueue.add('receivedAirbnbError', {
        error: JSON.stringify(error, getCircularReplacer()),
        apartmentId,
        listingId,
      })
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
