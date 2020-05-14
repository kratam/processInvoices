require('dotenv').config()
const Bull = require('bull')
const { AirbnbService } = require('./airbnb')
const Fiber = require('fibers')
const { makeCompatible } = require('meteor-promise')

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
  console.log(`running job ${job.id}`)
  const { companyId, hostId, tokens, lastMessageAt, ...rest } = job.data
  const airbnb = new AirbnbService({ token: tokens[0] })
  const threadsGenerator = airbnb.getThreadsGenerator({
    lastMessageAt,
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
    console.log(
      `Added job meteor.receivedAirbnbThreads ${job.id} (count: ${threads.length}, hostId: ${hostId}, companyId: ${companyId})`,
    )
  }
})

queue.process('getReservations', concurrency, function (job) {
  console.log(`running job ${job.id}`)
  const { apartmentId, listingId, encryptedToken } = job.data
  const airbnb = new AirbnbService({ token: encryptedToken })
  const reservationsGenerator = airbnb.getReservationsGenerator({
    listingId,
    limit: 5,
  })
  for (const reservations of reservationsGenerator) {
    try {
      const job = Promise.await(
        meteorQueue.add(
          'receivedAirbnbReservations',
          { reservations, apartmentId },
          {
            removeOnComplete: true,
          },
        ),
      )
      console.log(
        `Added job meteor.receivedAirbnbReservations ${job.id} (count: ${reservations.length}, apartmentId: ${apartmentId})`,
      )
    } catch (error) {
      console.error(`error adding job to meteorQueue`, error)
      throw error
    }
  }
})

console.log('getReservations waiting for jobs...')
