const axios = require('axios')
const get = require('lodash.get')

async function getSessionCookie(token) {
  const data = await axios({
    url: 'https://api.airbnb.com/v2/user_sessions',
    method: 'post',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Airbnb-OAuth-Token': token,
      'User-Agent': 'openApiFoundation',
    },
  }).then(r => r.data)
  const cookie = { sbc: 1 }
  const session = get(data, 'user_session')
  if (!session) throw new Error('no-session-in-response')
  cookie[session.cookie_name] = session.session_id
  cookie[session.aat_cookie_name] = session.aat
  return cookieToString(cookie)
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

module.exports = { getSessionCookie }
