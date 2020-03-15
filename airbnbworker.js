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

const concurrency = Number(process.env.CONCURRENCY || 5)

queue.process('getReservations', concurrency, function(job) {
  console.log(`running job ${job.id}`)
  const { apartmentId, listingId, encryptedToken } = job.data
  const airbnb = new AirbnbService({ token: encryptedToken })
  const reservationsGenerator = airbnb.getReservationsGenerator({
    listingId,
    limit: 5,
  })
  for (const reservations of reservationsGenerator) {
    Promise.await(
      queue.add(
        'receivedReservations',
        { reservations, apartmentId },
        {
          removeOnComplete: true,
        },
      ),
    )
  }
})

console.log('getReservations waiting for jobs...')
