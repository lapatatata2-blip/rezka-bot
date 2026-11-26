'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { runJob } = require('./src/pipeline')

const cookiesB64 = String(process.env.YT_COOKIES_B64 || '').replace(/\s+/g, '')
if (cookiesB64) {
  const file = path.join(os.tmpdir(), 'yt-cookies.txt')
  fs.writeFileSync(file, Buffer.from(cookiesB64, 'base64'))
  process.env.REZKA_COOKIES_FILE = file
}

const started = Date.now()
runJob(
  {
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    ranges: [{ start: 1, end: 19 }],
    outDir: './out',
    quality: 720,
    subLang: 'auto',
    burn: false,
    maxChunk: 60,
    orientation: 'vertical',
    tmpBase: '/tmp',
  },
  (e) => console.log('EVENT', e.type, e.stage || e.text || ''),
)
  .then((r) => {
    const sizes = r.files.map((f) => Math.round(fs.statSync(f.file).size / 1024 / 1024) + 'MB')
    console.log('DONE', Math.round((Date.now() - started) / 1000) + 's', sizes.join(' '))
  })
  .catch((e) => {
    console.error('FAIL', e && e.message)
    process.exit(1)
  })
