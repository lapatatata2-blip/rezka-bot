'use strict'

const { runJob } = require('./src/pipeline')

const started = Date.now()
runJob(
  {
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    ranges: [{ start: 1, end: 10 }],
    outDir: './out',
    quality: 480,
    subLang: 'auto',
    burn: true,
    maxChunk: 30,
    orientation: 'vertical',
    tmpBase: '/tmp',
  },
  (e) => console.log('EVENT', e.type, e.stage || e.text || ''),
)
  .then((r) => {
    console.log('DONE', Math.round((Date.now() - started) / 1000) + 's', r.files.map((f) => f.file))
  })
  .catch((e) => {
    console.error('FAIL', e && e.message)
    process.exit(1)
  })
