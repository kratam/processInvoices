require('dotenv').config()
const htmlPdf = require('html-pdf-chrome')
const Bull = require('bull')
const set = require('lodash.set')
const aws = require('aws-sdk')
const { getSessionCookie } = require('./airbnb')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const DEFAULT_OPTIONS = {
  port: process.env.CHROME_PORT || undefined, // port Chrome is listening on
  chromeFlags: [
    '--disable-gpu',
    '--headless',
    '--hide-scrollbars',
    '--window-size=1920,1080',
  ],
  printOptions: {
    scale: 0.7,
  },
}

const queue = new Bull('pdf', {
  redis: {
    port: process.env.BULL_PORT || 2407,
    host: process.env.BULL_HOST,
    password: process.env.BULL_PW,
    db: process.env.BULL_DB || 1,
  },
})

const s3 = new aws.S3({
  secretAccessKey: process.env.S3_SECRET,
  accessKeyId: process.env.S3_KEY,
  endpoint: process.env.S3_ENDPOINT || 'https://oss.nodechef.com',
  // sslEnabled: true, // optional
  httpOptions: {
    timeout: 6000,
    agent: false,
  },
})

const uploadToS3 = (Key, Body) => {
  return new Promise((resolve, reject) => {
    const S3_BUCKET = process.env.S3_BUCKET || 'airbnb-invoices'
    const request = {
      Bucket: S3_BUCKET,
      Key,
      Body,
      ContentType: 'application/pdf',
      ACL: 'public-read',
    }
    s3.putObject(request, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

queue.process('generate', 1, async function(job) {
  console.log(`running job ${job.id}`)
  const { ids, token } = job.data
  const Cookie = await getSessionCookie(token)
  await delay(400)
  const key = `${ids[0]}.pdf`
  const html = `https://www.airbnb.com/vat_invoices/${ids[0]}?hide_nav=true&platform=android`
  const options = { ...DEFAULT_OPTIONS }
  set(options, 'extraHTTPHeaders.Cookie', Cookie)
  return (
    htmlPdf
      .create(html, options)
      // check the string version, if it contains "please log in", we have a problem...
      .then(pdf => pdf.toBuffer())
      .then(buffer => uploadToS3(key, buffer))
      .then(() => console.log(`${key} uploaded`))
      .then(() =>
        queue.add('uploaded', {
          [ids[0]]: `https://airbnb-invoices.oss.nodechef.com/${key}`,
        }),
      )
      .catch(err => {
        console.error(err)
        throw err
      })
  )
})

console.log('Waiting for jobs...')
