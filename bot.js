'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')
const { startTelegramBot } = require('./src/telegram-bot')
const { runJob } = require('./src/pipeline')

const token = String(process.env.TELEGRAM_TOKEN || '').trim()
const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim()
const outDir = String(process.env.REZKA_OUT_DIR || path.join(os.tmpdir(), 'rezka-out'))

const cookiesB64 = String(process.env.YT_COOKIES_B64 || '').replace(/\s+/g, '')
if (cookiesB64) {
  const cookiesFile = path.join(os.tmpdir(), 'yt-cookies.txt')
  fs.writeFileSync(cookiesFile, Buffer.from(cookiesB64, 'base64'))
  process.env.REZKA_COOKIES_FILE = cookiesFile
}

if (!token || !chatId) {
  console.error('Нужны TELEGRAM_TOKEN и TELEGRAM_CHAT_ID')
  process.exit(1)
}

const account = { token, chatId, accessToken: token, name: 'Telegram' }

startTelegramBot({
  accounts: { get: (provider) => (provider === 'telegram' ? account : null) },
  runJob: async (opts, emit, control) => runJob({ ...opts, tmpBase: os.tmpdir() }, emit, control),
  isBusy: () => false,
  getOutDir: () => outDir,
  maxRuntimeMs: Number(process.env.MAX_RUNTIME_MS) || 9 * 60 * 1000,
})
