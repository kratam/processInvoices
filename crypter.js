class Crypter {
  constructor(key) {
    this.ch = require('crypto-simple')
    this.ch.key = key
  }
  encrypt(data, isObject = false) {
    try {
      const _data = isObject ? JSON.stringify(data) : data
      return this.ch.encrypt(_data)
    } catch (error) {
      console.error('[CRYPTER] Could not encrypt data', { error })
      throw new Error('encrypt-error')
    }
  }
  decrypt(encryptedString, isObject = false) {
    try {
      const dc = this.ch.decrypt(encryptedString)
      return isObject ? JSON.parse(dc) : dc
    } catch (error) {
      console.error('[CRYPTER] Could not decrypt data', {
        error,
        encryptedString,
      })
      throw new Error('decrypt-error')
    }
  }
}

module.exports = { Crypter }
