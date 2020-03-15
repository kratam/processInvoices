const axios = require('axios')
const axiosRetry = require('axios-retry')
const _ = require('lodash')
const { RateLimiter } = require('limiter')
const ical = require('node-ical')
const moment = require('moment')
const { Crypter } = require('./crypter')
const Fiber = require('fibers')
const { makeCompatible } = require('meteor-promise')

makeCompatible(Promise, Fiber)

const crypter = new Crypter(process.env.CRYPTER_KEY)

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3325.181 Safari/537.36'

const CLIENT_ID = '3092nxybyb0otqw18e8nh5nty'

// const log = level => (...args) => console.log(level, ...args)
const log = () => () => {}
const winston = global.winston || {
  error: log('error'),
  info: log('info'),
  warn: log('warn'),
  debug: log('debug'),
}

/**
 * Global limit for the number of requests per second.
 * 8 requests per 1000ms (1 second)
 */
const rateLimiter = new RateLimiter(8, 1000)

class AirbnbService {
  /**
   * @param {*} args
   * @param {string=} baseURL base airbnb api url
   * @param {string=} currency defaults to EUR
   * @param {string=} token airbnb token. required without email/pass
   * @param {string=} email airbnb login email. required if token is not set
   * @param {string=} password airbnb password
   */
  constructor({
    baseURL = 'https://api.airbnb.com',
    currency = 'EUR',
    token: encryptedToken,
    email,
    password,
    rateLimiter: _rateLimiter,
  } = {}) {
    this.email = email
    this.password = password
    this.crypter = crypter
    const token = encryptedToken
      ? this.crypter.decrypt(encryptedToken)
      : undefined
    this.token = token
    this.encryptedToken = encryptedToken

    this.axios = this.buildAxios({ baseURL, currency })
    this.rateLimiter = _rateLimiter || rateLimiter
  }

  /**
   * Throws an Error (in other envs this won't be Meteor.Error)
   * @param {*} code error
   * @param {*} message error message
   * @param {*} details error details
   */
  Error(code, message, details) {
    if (Meteor) throw new Meteor.Error(code, message, details)
    else throw new Error(code, message, details)
  }

  request(config, type = 'private') {
    const self = this
    const token = self.token
    if (type === 'private' && token)
      _.set(config, 'headers["X-Airbnb-OAuth-Token"]', token)
    try {
      const result = Promise.await(
        new Promise((resolve, reject) => {
          self.rateLimiter.removeTokens(1, err => {
            if (err) {
              winston.error(
                '[AIRBNB] Reached queue limit!! This should never happen',
                { error: err },
              )
            }
            self
              .axios(config)
              .then(response => response.data)
              .then(resolve)
              .catch(reject)
          })
        }),
      )

      return result
    } catch (error) {
      winston.debug('[AIRBNB] request threw')
      throw error
    }
  }
  buildAxios({ baseURL, currency }) {
    const x = axios.create({
      baseURL,
      params: {
        client_id: CLIENT_ID,
        locale: 'en-US',
        currency,
      },
      headers: {
        common: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json; charset=UTF-8',
        },
      },
    })
    x.defaults.timeout = 1000 * 60 // 30 seconds
    axiosRetry(x, {
      shouldResetTimeout: true,
      retries: 7,
      retryDelay: retryCount => retryCount * 1000,
      retryCondition: error => {
        winston.debug('[AIRBNB AXIOS] inside retryCondition', {
          error,
          status: _.get(error, 'response.status'),
          statusText: _.get(error, 'response.statusText'),
          data: _.get(error, 'response.data'),
          code: _.get(error, 'code'),
        })
        return (
          axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          error.code === 'ECONNABORTED'
        )
      },
    })
    x.interceptors.request.use(request => {
      winston.debug(
        `Axios to ${request.url}`,
        _.pick(request, ['url', 'params', 'method']),
      )
      return request
    })
    x.interceptors.response.use(response => {
      const fields = ['status', 'statusText']
      if (response.status !== 200) fields.push('data')
      winston.debug('Axios response', _.pick(response, fields))
      return response
    })

    return x
  }
  testConnection() {
    const user = this.getOwnUserInfo()
    return !!user && !!user.id
  }
  /**
   * get own user info
   */
  getOwnUserInfo() {
    try {
      const data = this.request({ url: '/v2/users/me' })
      const user = data.user
      this.userId = user.id
      this.user = user
      return user
    } catch (error) {
      this.userId = undefined
      this.user = undefined
      this.token = undefined
      return null
    }
  }

  /**
   * queues a pdf.generate job with the reservation's
   * invoiceIds.
   * @param {string} confirmationCode
   */
  queueInvoicePdf(confirmationCode, deps = {}) {
    const queue = deps.queue || require('/api/services').queue
    const ids = this.getInvoiceIds(confirmationCode)
    if (ids.length === 0) return
    const encryptedToken = this.encryptedToken
    return queue.addJob({
      queue: 'pdf',
      name: 'generate',
      data: { ids, encryptedToken },
    })
  }

  /**
   * get a session to use for other requests. The returned
   * string must be added to the next request's Cookie header
   * @return {string} to be used in header.Cookie
   */
  getSessionCookie() {
    const data = this.request({
      url: '/v2/user_sessions',
      method: 'post',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
    })
    const cookie = { sbc: 1 }
    const session = _.get(data, 'user_session', {})
    cookie[session.cookie_name] = session.session_id
    cookie[session.aat_cookie_name] = session.aat
    return cookieToString(cookie)
  }

  /**
   * Returns html document containing the invoice
   * @param {string} invoiceId an airbnb invoice id
   */
  getInvoiceById(invoiceId) {
    const Cookie = this.getSessionCookie()
    const html = this.request({
      url: `https://www.airbnb.com/vat_invoices/${invoiceId}?hide_nav=true&platform=android`,
      headers: { Cookie },
    })
    return html
  }

  /**
   * returns the first invoice of a reservation
   * @param {string} confirmationCode
   */
  getFirstInvoice(confirmationCode) {
    const ids = this.getInvoiceIds(confirmationCode)
    if (ids.length === 0)
      throw new this.Error('no-invoices', 'This reservation has no invoices')
    return this.getInvoiceById(ids[0])
  }

  /**
   * get invoice ids of a reservation
   * @param {string} confirmationCode
   * @return {string[]} array of invoice ids
   */
  getInvoiceIds(confirmationCode) {
    const quote = this.getBookingPricingQuotes(confirmationCode)
    return _.get(
      quote,
      'homes_host_booking_pricing_quote.vat_invoices',
      [],
    ).map(i => i.id)
  }

  /**
   * returns airbnb object containing price details and invoice ids
   * @param {string} confirmationCode
   */
  getBookingPricingQuotes(confirmationCode) {
    return this.request({
      url: `/v2/homes_host_booking_pricing_quotes/${confirmationCode}`,
      params: { _format: 'for_remy' },
    })
  }

  /**
   * returns airbnb object containing information about the booking
   * this is more detailed, e.g. it shows if the reservation was
   * withdrawn by the guest in 24 hours or if an airbnb admin 'canceled' it
   * @param {string} confirmationCode
   */
  getBookingSummary(confirmationCode) {
    return this.request({
      url: `/v2/booking_summaries/${confirmationCode}`,
      params: { _format: 'for_remy' },
    })
  }

  /**
   * @typedef {Object} ReservationLike a reservation-like object
   * @property {string} startDate YYYY-MM-DD
   * @property {string} endDate YYYY-MM-DD
   * @property {string} apartmentId id of an apartment
   * @property {Object} airbnb airbnb-related fields of a reservation
   * @property {string} airbnb.uid the VEVENT's uid
   * @property {string=} airbnb.summary the summary of the event (probably like "John D (HMC3445)")
   * @property {string=} airbnb.description the full description
   */

  /**
   * retrieves an airbnb feed and parses the returned vevents to apartment
   * @param {string} feed the url of the feed
   * @param {string} apartmentId the Id of the apartment
   * @returns {ReservationLike[]}
   */
  parseFeed(feed, apartmentId) {
    try {
      const ics = this.request({ url: feed }, 'public')
      const events = ical.parseICS(ics)
      return _.map(events, event => {
        if (
          event.type === 'VEVENT' &&
          // do not import blocked dates ("Airbnb (Not available)")
          event.summary &&
          event.summary === 'Reserved'
        ) {
          const re = /code=\w+/gi
          const codeMatch = event.description.match(re)
          // match is code=XXXX
          const confirmationCode = _.get(codeMatch, '[0]', '=').split('=')[1]
          if (!confirmationCode) return null // we must have a confirmation code
          return {
            apartmentId,
            startDate: moment(event.start).format('YYYY-MM-DD'),
            endDate: moment(event.end).format('YYYY-MM-DD'),
            airbnb: {
              uid: event.uid,
              summary: event.summary,
              description: event.description,
              confirmationCode,
            },
            channel: 'airbnb',
            paymentType: 'wire',
          }
        }
      }).filter(valid => valid) // not VEVENT
    } catch (error) {
      winston.error('[AIRBNB] Error getting res from feed', { error })
      throw error
    }
  }

  /**
   * Get reservations in batches
   * @param {object=} args
   * @param {string} args.listingId
   * @param {number=} args.limit number of reservations per batch, maximum 10
   * @yields {AirbnbReservations[]} Reservations array
   */
  *getReservationsGenerator({ listingId, limit = 10 } = {}) {
    let offset = 0
    let lastResultsCount = limit // initial value for convenience
    while (lastResultsCount === limit) {
      const results = this.getReservations({ offset, limit, listingId })
      lastResultsCount = results.length
      offset += lastResultsCount
      yield results
    }
  }

  /**
   * Get the reservations
   * @param {*} args
   * @param {number} args.offset
   * @param {number} args.limit
   */
  getReservations({ offset = 0, limit = 10, listingId } = {}) {
    check(offset, Number)
    check(limit, Number)
    const RESERVATION_MAX_LIMIT = 10
    if (limit > RESERVATION_MAX_LIMIT)
      throw new this.Error(
        'limit-too-high',
        `Cannot get more than ${RESERVATION_MAX_LIMIT} reservations at once, use getAllReservations`,
      )
    try {
      const params = {
        _format: 'for_mobile_host',
        _offset: offset,
        _limit: limit,
        order_by: 'start_date',
        include_accept: true,
        include_canceled: true,
        // see options: https://github.com/drawrowfly/airbnb-private-api/blob/master/src/core/AirBnb.ts#L596
      }
      if (listingId) params.listing_id = listingId
      const data = this.request({
        method: 'get',
        url: '/v2/reservations',
        params,
      })
      const reservations = data && data.reservations
      // this means no reservations property in the data
      // and not 0 reservations matching the query
      if (!reservations)
        throw new this.Error(
          'no-reservations-in-response',
          'Response has no reservations',
        )
      return reservations
    } catch (error) {
      winston.error('[AIRBNB] Error in getReservations', { error })
      throw error
    }
  }

  /**
   * Get details of multiple reservations
   * @param {*} args
   * @param {number[]} args.ids array of reservation ids
   */
  getReservationsBatch({ ids }) {
    check(ids, [Number])
    // get the reservations in chunks
    const MAX_IDS_PER_REQUEST = 5
    if (ids.length > MAX_IDS_PER_REQUEST) {
      return _.flatten(
        _.chunk(ids, MAX_IDS_PER_REQUEST).map(chunkedIds =>
          this.getReservationsBatch({ ids: chunkedIds }),
        ),
      )
    }
    const operations = ids.map(id => ({
      method: 'GET',
      path: `/v2/reservations/${id}`,
      query: {
        _format: 'for_mobile_host',
      },
    }))
    const data = {
      operations,
      _transaction: false,
    }
    try {
      const response = this.request({ url: '/v2/batch', method: 'post', data })
      return (
        response.operations
          .map(o => {
            const reservation = _.get(o, 'response.reservation')
            if (!reservation) {
              winston.error('[AIRBNB] No reservation in response operation', {
                operation: o,
              })
            }
            return reservation
          })
          // filter out errors
          .filter(v => v)
      )
    } catch (error) {
      winston.error('[AIRBNB] Error in getReservationsBatch', { error })
    }
  }

  /**
   * New login method since 2020.01.
   * @returns {{success: boolean, reason?: string, token?: string}}
   */
  loginV2() {
    check(this.email, String)
    check(this.password, String)
    try {
      const data = this.request({
        url: '/v2/authentications',
        method: 'post',
        headers: {
          'x-airbnb-device-id': 'openApiFoundation',
          'User-Agent': USER_AGENT,
        },
        data: {
          authenticationParams: {
            email: {
              email: this.email,
              password: this.password,
            },
          },
        },
      })

      const token = _.get(data, 'token')
      const userId = _.get(data, 'filledAccountData.userId')
      if (!token || !userId)
        throw new this.Error(
          'login-error',
          'Response does not contain token or userId',
        )
      this.userId = userId
      this.token = token
      const encryptedToken = this.crypter.encrypt(token)
      return { success: true, token: encryptedToken }
    } catch (error) {
      const status = _.get(error, 'response.status')
      switch (status) {
        case 403:
          return { success: false, reason: 'invalid-password' }
        default: {
          winston.error('Unhandled error during airbnb verification', { error })
          throw error
        }
      }
    }
  }

  /**
   * retrieve the listings of the current user or passed in user
   * @param {string=} userId id of the target user
   * @param {string=} listingId id of a listing
   */
  getListings({ userId, listingId }) {
    if (!listingId && !userId && !this.userId)
      throw new this.Error('id-required', 'userId or listingId is required')
    const params = {
      // _format: 'v1_legacy_long',
      // has_availability: false,
    }
    if (listingId) params.listing_ids = listingId
    else params.user_id = userId || this.userId

    try {
      return this.request({ url: '/v2/listings', params })
    } catch (e) {
      winston.error('[AIRBNB] Error in getListings', { error: e })
      throw new this.Error(
        'error-getting-listings',
        'Could not retreive listings from airbnb',
      )
    }
  }

  *getReviewsGenerator({ listingId } = {}) {
    const limit = 20
    let offset = 0
    let lastResultsCount = limit // initial value for convenience
    while (lastResultsCount === limit) {
      const results = this.getReviews({ offset, limit, listingId })
      lastResultsCount = results.reviews.length
      offset += lastResultsCount
      yield results
    }
  }

  /**
   * get the reviews from airbnb
   * @param {object=} args arguments
   * @param {number=} args.listingId listingId to narrow down reviews
   * @param {number=} args.limit limit the number of retreived reviews
   * @param {number=} args.offset offset the reviews (skip before X)
   */
  getReviews({ listingId, limit = 40, offset = 0 } = {}) {
    check(listingId, Match.Maybe(String))
    check(limit, Number)
    check(offset, Number)
    try {
      const params = {
        reviewee_id: this.userId,
        listing_id: listingId,
        _limit: limit,
        _offset: offset,
        _format: 'for_web_host_stats',
        _order: 'recent',
        role: 'guest',
      }
      return this.request({ url: '/v2/reviews', params })
    } catch (e) {
      winston.error('Error getting reviews from airbnb', { error: e })
      throw e
    }
  }
}

/**
 * converts an object to a string
 * @param {*} cookie cookie object with key:values
 */
function cookieToString(cookie) {
  return Object.keys(cookie)
    .map(key => `${key}=${encodeURIComponent(cookie[key])}`)
    .join(';')
}

function check() {}

module.exports = { AirbnbService }
