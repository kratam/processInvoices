const axios = require('axios')
const axiosRetry = require('axios-retry')
const _ = require('lodash')
const { RateLimiter } = require('limiter')
const ical = require('node-ical')
const moment = require('moment')
const { Crypter } = require('./crypter')
const Fiber = require('fibers')
const { makeCompatible } = require('meteor-promise')
const { logger: winston } = require('./logger')

makeCompatible(Promise, Fiber)

const crypter = new Crypter(process.env.CRYPTER_KEY)

// const log = (level) => (...args) => console.log(level, ...args)
// const log = () => () => {}
// const winston = global.winston || {
//   error: log('error'),
//   info: log('info'),
//   warn: log('warn'),
//   debug: log('debug'),
// }

/* COMMON CODE FROM HERE */

const USER_AGENT =
  'Airbnb/21057117 AppVersion/20.07.1 Android/10.0 Device/Pixel 2 XL Carrier/US T-MOBILE Type/Phone'

const CLIENT_ID = '3092nxybyb0otqw18e8nh5nty'

const DEVICE_ID = 'plzweneedopenapi'

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
   * @param {*} rateLimiter rateLimiter instance
   * @param {func} rateLimiter.removeTokens
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

  request(config, type = 'private') {
    const self = this
    const token = self.token
    if (type === 'private' && token)
      _.set(config, 'headers["X-Airbnb-OAuth-Token"]', token)
    // set device id..
    _.set(config, 'headers["x-airbnb-device-id"]', DEVICE_ID)
    try {
      const result = Promise.await(
        new Promise((resolve, reject) => {
          self.rateLimiter.removeTokens(1, (err) => {
            if (err) {
              winston.error(
                '[AIRBNB] Reached queue limit!! This should never happen',
                { error: err },
              )
            }
            self
              .axios(config)
              .then((response) => response.data)
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
      retryDelay: (retryCount) => retryCount * 1000,
      // retryCondition: error => {
      //   winston.debug('[AIRBNB AXIOS] inside retryCondition', {
      //     error,
      //     status: _.get(error, 'response.status'),
      //     statusText: _.get(error, 'response.statusText'),
      //     data: _.get(error, 'response.data'),
      //     code: _.get(error, 'code'),
      //   })
      //   return (
      //     axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      //     error.code === 'ECONNABORTED'
      //   )
      // },
    })
    x.interceptors.request.use((request) => {
      winston.debug(
        `[AIRBNB] Axios to ${request.url}`,
        _.pick(request, ['url', 'params', 'method']),
      )
      return request
    })
    x.interceptors.response.use((response) => {
      const fields = ['status', 'statusText']
      if (response.status !== 200) fields.push('data')
      winston.debug('[AIRBNB] Axios response', _.pick(response, fields))
      return response
    })

    return x
  }

  /**
   * checks if the current instance is authenticated and works
   * @returns {boolean}
   */
  testConnection() {
    const user = this.getOwnUserInfo()
    return !!user && !!user.id
  }

  /**
   * return the apartments of a user from a room url
   * @param {*} args
   * @param {string} args.url airbnb room url
   * @returns {object[]} listings array
   */
  getApartmentsFromListingUrl({ url }) {
    check(url, String)
    const airbnb = this
    const listingId = airbnb.extractNumber(url)
    const userId = _.get(airbnb.getListings({ listingId }), '[0].user.id')
    const listings = airbnb.getListings({ userId }) || []
    const reverse = require('/server/geocoder').reverse
    const mapPropertyType = (type) => {
      switch (type) {
        case 'private_room':
          return 'roomWithBath'
        default:
          return 'apartment'
      }
    }
    // get listing address
    for (const listing of listings) {
      try {
        const res = Promise.await(reverse([listing.lat, listing.lng]))
        listing.address = airbnb.parseResultToAddress(res)
      } catch (error) {
        winston.error('[AIRBNB] Geocoding error', { error })
      }
    }
    return listings.map((l) => ({
      airbnb: {
        id: String(l.id),
      },
      location: {
        type: 'Point',
        coordinates: [l.lat, l.lng],
      },
      address: l.address,
      avatar: {
        url: l.x_medium_picture_url,
        imageKey: 'external',
      },
      name: l.name,
      // default required values
      type: mapPropertyType(l.room_type_category),
      cleaningFeeMethod: 'WITH_ACCOMMODATION',
      currency: 'HUF',
      beds: [],
      taxIncludedInAccFee: true,
      taxPercent: 4,
      vatRate: {
        accommodationFee: 'AAM',
        cleaningFee: 'AAM',
      },
    }))
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
   * @typedef {Object} GetThreadsOpts
   * @property {number} [limit=10]
   * @property {number} [offset=0]
   */

  /**
   * get thread ids
   * @param {GetThreadsOpts} args
   */
  getThreadIds(args = {}) {
    return this._getThreads({ full: false, ...args })
  }

  *getThreadsGenerator({ lastMessageAt, maxRounds = 5, limit = 10, ...args }) {
    let offset = 0
    let round = 0
    // set to limit for convenience
    let lastResultsCount = limit
    // will turn to true if their last message is older than ours
    let seenOlderMessageThanOurLastMessage = false
    while (
      round < maxRounds &&
      lastResultsCount === limit &&
      !seenOlderMessageThanOurLastMessage
    ) {
      try {
        const { threads } = this.getThreads({ ...args, offset, limit })
        yield threads
        lastResultsCount = threads.length
        seenOlderMessageThanOurLastMessage =
          lastMessageAt && lastMessageAt.getTime
            ? new Date(_.last(threads).last_message_at).getTime() <=
              lastMessageAt.getTime()
            : false
        offset += lastResultsCount
        round += 1
      } catch (error) {
        yield error
        // set last result count to 0 so while is stopped
        lastResultsCount = 0
      }
    }
  }

  /**
   * Get full threads
   * @param {GetThreadsOptions} args
   */
  getThreads(args = {}) {
    return this._getThreads(args)
  }

  /**
   * @typedef {GetThreadsOpts} _GetThreadsOpts
   * @property {boolean} [full=true]
   *
   * Generic method to request to return threads
   * @param {GetThreadsExtraOpts} args
   */
  _getThreads({ full = true, limit = 10, offset = 0 } = {}) {
    try {
      return this.request({
        url: '/v2/threads',
        params: {
          selected_inbox_type: 'host',
          _limit: limit,
          _offset: offset,
          ...(full
            ? {
                _format: 'for_messaging_sync_with_posts_china',
                include_generic_bessie_threads: true,
                include_luxury_assisted_booking_threads: true,
                include_mt: true,
                include_plus_onboarding_threads: true,
                include_restaurant_threads: true,
                include_support_messaging_threads: true,
                role: 'all',
              }
            : {}),
        },
      })
    } catch (error) {
      throw new MeteorError(
        _.get(error, 'response.status'),
        _.get(error, 'response.statusText'),
        error.response,
      )
    }
  }

  /**
   * Get a single airbnb messaging thread
   * @param {number} id airbnb threadId
   */
  getThread(id) {
    return this.request({
      url: `/v2/threads/${id}`,
      params: { _format: 'for_messaging_sync_with_posts_china' },
    })
  }

  /**
   * queues a pdf.generate job with the reservation's
   * invoiceIds.
   * @param {string} confirmationCode
   * @param {Object} [deps]
   * @param {*} [deps.queue] optional queue instance
   */
  queueInvoicePdf(confirmationCode, deps = {}) {
    const queue = deps.queue || require('/api/services').queue
    const ids = this.getInvoiceIds(confirmationCode)
    if (ids.length === 0) return
    const encryptedToken = this.encryptedToken
    return queue.addJob({
      queue: 'invoice-worker',
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
    return this.cookieToString(cookie)
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
      throw new MeteorError('no-invoices', 'This reservation has no invoices')
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
    ).map((i) => i.id)
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
      return _.map(events, (event) => {
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
      }).filter((valid) => valid) // not VEVENT
    } catch (error) {
      winston.error('[AIRBNB] Error getting res from feed', { error })
      throw error
    }
  }

  /**
   * Get reservations in batches
   * @param {object} args
   * @param {string=} args.listingId
   * @param {number=} args.limit number of reservations per batch, maximum 10
   * @yields {AirbnbReservations[]} Reservations array
   */
  *getReservationsGenerator({ listingId, limit = 10 } = {}) {
    let offset = 0
    let lastResultsCount = limit // initial value for convenience
    let seenError = false
    while (lastResultsCount === limit || seenError) {
      try {
        const results = this.getReservations({ offset, limit, listingId })
        yield results
        lastResultsCount = results.length
        offset += lastResultsCount
      } catch (error) {
        yield error
        seenError = true
      }
    }
  }

  /**
   * Get the reservations
   * @param {object} args
   * @param {number=} args.offset
   * @param {number=} args.limit
   * @param {string=} args.listingId
   */
  getReservations({ offset = 0, limit = 10, listingId } = {}) {
    check(offset, Number)
    check(limit, Number)
    const RESERVATION_MAX_LIMIT = 10
    if (limit > RESERVATION_MAX_LIMIT)
      throw new MeteorError(
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
        ...(listingId ? { listing_id: listingId } : {}),
        // see options: https://github.com/drawrowfly/airbnb-private-api/blob/master/src/core/AirBnb.ts#L596
      }
      const data = this.request({
        method: 'get',
        url: '/v2/reservations',
        params,
      })
      const reservations = data && data.reservations
      // this means no reservations property in the data
      // and not 0 reservations matching the query
      if (!reservations)
        throw new MeteorError(
          'no-reservations-in-response',
          'Response has no reservations',
        )
      return reservations
    } catch (error) {
      throw new MeteorError(
        _.get(error, 'response.status'),
        _.get(error, 'response.statusText'),
        error.response,
      )
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
        _.chunk(ids, MAX_IDS_PER_REQUEST).map((chunkedIds) =>
          this.getReservationsBatch({ ids: chunkedIds }),
        ),
      )
    }
    const operations = ids.map((id) => ({
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
          .map((o) => {
            const reservation = _.get(o, 'response.reservation')
            if (!reservation) {
              winston.error('[AIRBNB] No reservation in response operation', {
                operation: o,
              })
            }
            return reservation
          })
          // filter out errors
          .filter((v) => v)
      )
    } catch (error) {
      winston.error('[AIRBNB] Error in getReservationsBatch', { error })
    }
  }

  /**
   * @typedef {Object} LoginV2Return
   * @property {boolean} success indicates the success of the call
   * @property {string} [reason] the reason if the login failed
   * @property {string} [token] the encrypted token if the login was successful
   *
   * @typedef {Object} LoginV2Opts
   * @property {string} [airbnbAccountId] one id
   */

  /**
   * New login method since 2020.01.
   * @param {LoginV2Opts} [args] optional arguments, used for emit
   * @returns {LoginV2Return}
   */
  loginV2({ airbnbAccountId } = {}) {
    check(this.email, String)
    check(this.password, String)
    try {
      const data = this.request({
        url: '/v2/authentications',
        method: 'post',
        headers: {
          'x-airbnb-device-id': 'plzweneedopenapi',
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
        throw new MeteorError(
          'login-error',
          'Response does not contain token or userId',
        )
      this.userId = userId
      this.token = token
      const encryptedToken = this.crypter.encrypt(token)
      const listings = this.getListings().map(({ id, name }) => ({ id, name }))
      // TODO: check that this account has airbnbId (listing id) before emitting this
      // because a listener will save it to the apartment
      Emitter.emit(Events.AIRBNB_LOGIN, {
        encryptedToken,
        listings,
        userId,
        airbnbAccountId,
      })
      return { success: true, token: encryptedToken, listings }
    } catch (error) {
      const status = _.get(error, 'response.status')
      switch (status) {
        case 403:
          Emitter.emit(Events.AIRBNB_LOGIN_FAILED, {
            airbnbAccountId,
            email: this.email,
            reason: 'invalid-password',
          })
          return { success: false, reason: 'invalid-password' }
        case 420: {
          const airlock = this.passAirlock({
            airlock: this._extractAirlock({ error }),
          })
          return { success: true, airlock }
        }
        default: {
          winston.error('[AIRBNB] Unhandled error during airbnb verification', {
            error,
          })
          Emitter.emit(Events.AIRBNB_LOGIN_FAILED, {
            airbnbAccountId,
            error,
            reason: 'unhandled-error',
          })
          throw error
        }
      }
    }
  }

  /**
   * @typedef {Object} AirlockFriction
   * @property {string} name name (or type) of the friction
   * @property {string=} obfuscated obfuscated email/phone address if applicable
   * @property {string=} url url of the captcha (if name === 'captcha')
   * @property {number=} id phone number id (if name !== 'captcha')
   *
   * @typedef {Object} Airlock
   * @property {number} id airlock id
   * @property {AirlockFriction[]} frictions airlock frictions
   */

  /**
   * request a code OR unlocks airlock with code
   * @param {*} args
   * @param {Airlock} airlock our airlock object with frictions
   * @param {string=} code OTP code
   * @returns {Airlock}
   */
  passAirlock({ airlock, code }) {
    if (!airlock) return

    const friction = airlock.frictions[0]
    // captcha has to be solved by the user
    if (friction.name === 'captcha') return airlock

    // otherwise reqest/post a OTP
    const data = {
      action_name: 'account_login',
      friction: airlock.frictions[0].name,
      id: airlock.id,
      ...(code
        ? { friction_data: { response: { code } } }
        : { friction_data: {}, attempt: true }),
    }

    // add phone number id when applicable
    if (friction.id)
      _.set(data, 'friction_data.optionSelection.phone_number_id', friction.id)

    try {
      // request/post OTP code
      this.request(
        {
          url: `/v2/airlocks/${airlock.id}`,
          method: 'put',
          data,
          params: { _format: 'v1' },
        },
        'public',
      )
      return airlock
    } catch (error) {
      throw error
    }
  }

  /**
   * extract and transform an airlock object from the login response
   * @returns {Airlock}
   */
  _extractAirlock({ error }) {
    const airlock = _.get(error, 'response.data.client_error_info.airlock')
    if (!airlock) return null
    const frictions = [
      ...this._captchaFriction({ airlock }),
      ...this._emailFriction({ airlock }),
      ...this._smsFriction({ airlock }),
      ...this._callFriction({ airlock }),
    ]
    const response = {
      id: airlock.id,
      frictions,
    }
    return response
  }

  /**
   * get captcha friction from airbnb response
   * @returns {AirlockFriction}
   */
  _captchaFriction({ airlock }) {
    const friction = airlock.friction_data.find((f) => f.name === 'captcha')
    if (!friction) return []
    return [
      {
        name: 'captcha',
        androidSiteKey: friction.data.android_site_key,
        siteKey: friction.data.site_key,
        url: `https://www.airbnb.com/airlock?al_id=${airlock.id}`,
      },
    ]
  }

  /**
   * get email friction from airbnb response
   * @returns {AirlockFriction}
   */
  _emailFriction({ airlock }) {
    const friction = airlock.friction_data.find(
      (f) => f.name === 'email_code_verification',
    )
    if (!friction) return []
    return [
      {
        name: 'email_code_verification',
        obfuscated: friction.data.obfuscated_email_address,
      },
    ]
  }

  /**
   * get sms friction from airbnb response
   * @returns {AirlockFriction}
   */
  _smsFriction({ airlock }) {
    const friction = airlock.friction_data.find(
      (f) => f.name === 'phone_verification_via_text',
    )
    if (!friction) return []
    return friction.data.phone_numbers.map((phone) => ({
      name: 'phone_verification_via_text',
      obfuscated: phone.obfuscated,
      verifiedAt: phone.verified_at,
      id: phone.id,
    }))
  }

  /**
   * get phonecall friction from airbnb response
   * @returns {AirlockFriction}
   */
  _callFriction({ airlock }) {
    const friction = airlock.friction_data.find(
      (f) => f.name === 'phone_verification_via_call',
    )
    if (!friction) return []
    return friction.data.phone_numbers.map((phone) => ({
      name: 'phone_verification_via_call',
      obfuscated: phone.obfuscated,
      verifiedAt: phone.verified_at,
      id: phone.id,
    }))
  }

  /**
   * @typedef {Object} GetListingsOpts
   * @property {string|number} [userId] airbnb user id
   * @property {string|number} [listingId] airbnb listing id
   */

  /**
   * retrieve the listings of the current user or passed in user
   * @param {GetListingOpts} args an airbnb userId or listingId
   */
  getListings({ userId, listingId } = {}) {
    if (!listingId && !userId && !this.userId)
      throw new MeteorError('id-required', 'userId or listingId is required')
    const params = {
      _offset: 0,
      _limit: 20,
    }
    if (listingId) params.listing_ids = listingId
    else params.user_id = userId || this.userId

    // v2/listings can return metdata or paging...
    const getOffset = (data, listings) => {
      if (listingId) return null // do not paginate when listingId is requested
      if (data && data.paging && data.paging.next_offset)
        return data.paging.next_offset
      if (
        data &&
        data.metadata &&
        data.metadata.listing_count &&
        data.metadata.listing_count > listings.length
      )
        return listings.length
      return null
    }

    try {
      let listings = []
      while (params._offset !== null) {
        const data = this.request({ url: '/v2/listings', params })
        listings = [...listings, ...data.listings]
        params._offset = getOffset(data, listings)
      }
      return listings
    } catch (e) {
      winston.error('[AIRBNB] Error in getListings', { error: e })
      throw new MeteorError(
        'error-getting-listings',
        'Could not retreive listings from airbnb',
      )
    }
  }

  /**
   * @typedef {Object} SendMessageOpts
   * @property {string|number} threadId an airbnb thread.id
   * @property {string} message the message to send
   *
   * @typedef {Object} SendMessageResponse
   * @property {Object} message
   * @property {number} message.id
   * @property {Object} meta
   */

  /**
   * Sends a message to a thread
   * @param {SendMessageOpts} args
   * @returns {SendMessageResponse}
   */
  sendMessage({ threadId, message }) {
    const response = this.request({
      method: 'post',
      url: '/v2/messages',
      data: {
        message,
        thread_id: threadId,
      },
    })
    return response
  }

  *getReviewsGenerator({ listingId } = {}) {
    const limit = 20
    let offset = 0
    let lastResultsCount = limit // initial value for convenience
    while (lastResultsCount === limit) {
      const results = this.getReviews({ offset, limit, listingId })
      yield results
      lastResultsCount = results.reviews.length
      offset += lastResultsCount
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
      winston.error('[AIRBNB] Error getting reviews from airbnb', { error: e })
      throw e
    }
  }

  /////// HELPER METHODS \\\\\\
  /**
   * converts an object to a string
   * @param {*} cookie cookie object with key:values
   */
  cookieToString(cookie) {
    return Object.keys(cookie)
      .map((key) => `${key}=${encodeURIComponent(cookie[key])}`)
      .join(';')
  }

  /**
   * @typedef {Object} ParsedObj the returned object
   * @property {string} address the address of the location
   * @property {string} locality town/city
   * @property {string} country
   * @property {string} postcode zipcode/postcode
   * Parses a result of a reverse geocode query to an object
   * @param {*} result the result of a reverse geocode lookup
   * @returns {ParsedObj}
   */
  parseResultToAddress(result) {
    const provider = _.get(result, '[0].provider')
    switch (provider) {
      case 'google': {
        const address = _.get(result, '[0].streetName')
        const locality = _.get(result, '[0].city')
        const country = _.get(result, '[0].country')
        const postcode = _.get(result, '[0].zipcode')
        return { address, locality, country, postcode }
      }
      default: {
        throw new MeteorError('unknown-provider')
      }
    }
  }

  /**
   * extracts the first number from a string (url) or throws an error
   * @param {string} string string to extract number from
   * @returns {string} string representation of the first number
   */
  extractNumber(string) {
    check(string, String)
    const re = /\d+/g
    const matches = string.match(re)
    if (!matches) throw new MeteorError('no-number', 'No number in this url')
    return matches[0]
  }
}

function check() {}

class MeteorError extends Error {
  constructor(error, reason, details, ...params) {
    super(...params)
    const self = this
    if (Error.captureStackTrace) {
      // V8 environments (Chrome and Node.js)
      Error.captureStackTrace(this, MeteorError)
    }
    self.error = error
    self.reason = reason
    self.details = details
    if (self.reason) self.message = self.reason + ' [' + self.error + ']'
    else self.message = '[' + self.error + ']'
  }
}

module.exports = { AirbnbService }
