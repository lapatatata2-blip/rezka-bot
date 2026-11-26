'use strict'

const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { Readable } = require('stream')

const YT_SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly'
const TT_SCOPES = 'user.info.basic,video.upload'
const TT_PORT = 53682
const TT_REDIRECT = `http://127.0.0.1:${TT_PORT}/oauth/tiktok`

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function openBrowser(url) {
  try {
    const { shell } = require('electron')
    shell.openExternal(url)
  } catch {}
}

function waitForCode(server, expectedState, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('Время ожидания входа истекло — попробуй ещё раз'))
    }, timeoutMs)
    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error') || url.searchParams.get('error_description')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<html><body style="font-family:system-ui;background:#1a1025;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>REZKA</h2><p>' +
          (error ? 'Не удалось войти. Вернись в приложение.' : 'Готово! Можешь закрыть эту вкладку.') +
          '</p></div></body></html>'
      )
      if (error) {
        clearTimeout(timer)
        server.close()
        reject(new Error(error))
      } else if (code && state === expectedState) {
        clearTimeout(timer)
        server.close()
        resolve(code)
      }
    })
  })
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function formPost(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`)
  const data = JSON.parse(text)
  if (data && data.error) {
    throw new Error(data.error_description || data.error)
  }
  return data
}

async function jsonRequest(url, options = {}) {
  const res = await fetch(url, options)
  const text = await res.text()
  if (!res.ok) {
    let message = text
    try {
      const data = JSON.parse(text)
      message = (data.error && (data.error.message || data.error.code)) || data.message || text
    } catch {}
    throw new Error(message || `HTTP ${res.status}`)
  }
  return text ? JSON.parse(text) : {}
}

/* ---------- YouTube ---------- */

async function refreshYoutube(creds) {
  const data = await formPost('https://oauth2.googleapis.com/token', {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
  })
  return {
    ...creds,
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  }
}

async function youtubeConnect(creds) {
  if (!creds.clientId || !creds.clientSecret) throw new Error('Нужны Client ID и Client Secret')
  const state = base64url(crypto.randomBytes(16))
  const server = http.createServer()
  const port = await listen(server, 0)
  const redirect = `http://127.0.0.1:${port}/oauth/youtube`

  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: YT_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    }).toString()

  const codePromise = waitForCode(server, state)
  openBrowser(authUrl)
  const code = await codePromise

  const data = await formPost('https://oauth2.googleapis.com/token', {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
  })

  const account = {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    name: 'YouTube',
  }

  try {
    const info = await jsonRequest(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${account.accessToken}` } }
    )
    const item = (info.items || [])[0]
    if (item && item.snippet) account.name = item.snippet.title
  } catch {}

  return account
}

async function youtubeAccess(account) {
  if (account.accessToken && account.expiresAt && account.expiresAt > Date.now() + 60000) {
    return account.accessToken
  }
  const refreshed = await refreshYoutube(account)
  Object.assign(account, refreshed)
  return refreshed.accessToken
}

async function youtubeUpload(account, file, title, description, onProgress) {
  const accessToken = await youtubeAccess(account)
  const size = fs.statSync(file).size

  const init = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: {
          title: title.slice(0, 100),
          description,
          categoryId: '22',
          tags: ['Shorts'],
        },
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
      }),
    }
  )
  if (!init.ok) throw new Error(`YouTube: ${await init.text()}`)
  const uploadUrl = init.headers.get('location')
  if (!uploadUrl) throw new Error('YouTube не вернул ссылку для загрузки')

  const stream = fs.createReadStream(file)
  let sent = 0
  stream.on('data', (chunk) => {
    sent += chunk.length
    if (onProgress) onProgress(Math.min(1, sent / size))
  })

  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) },
    body: Readable.toWeb(stream),
    duplex: 'half',
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`YouTube: ${text || `HTTP ${res.status}`}`)
  return text ? JSON.parse(text) : {}
}

/* ---------- TikTok ---------- */

async function refreshTiktok(account) {
  const data = await formPost('https://open.tiktokapis.com/v2/oauth/token/', {
    client_key: account.clientKey,
    client_secret: account.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
  })
  return {
    ...account,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || account.refreshToken,
    expiresAt: Date.now() + (Number(data.expires_in) || 86400) * 1000,
  }
}

async function tiktokConnect(creds) {
  if (!creds.clientKey || !creds.clientSecret) throw new Error('Нужны Client Key и Client Secret')
  const state = base64url(crypto.randomBytes(16))
  const verifier = base64url(crypto.randomBytes(48))
  // TikTok требует hex от SHA256, а не base64url как в RFC 7636
  const challenge = crypto.createHash('sha256').update(verifier).digest('hex')

  const server = http.createServer()
  try {
    await listen(server, TT_PORT)
  } catch {
    throw new Error(`Порт ${TT_PORT} занят — закрой другую копию REZKA и попробуй снова`)
  }

  const authUrl =
    'https://www.tiktok.com/v2/auth/authorize/?' +
    new URLSearchParams({
      client_key: creds.clientKey,
      scope: TT_SCOPES,
      response_type: 'code',
      redirect_uri: TT_REDIRECT,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()

  const codePromise = waitForCode(server, state)
  openBrowser(authUrl)
  const code = await codePromise

  const data = await formPost('https://open.tiktokapis.com/v2/oauth/token/', {
    client_key: creds.clientKey,
    client_secret: creds.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: TT_REDIRECT,
    code_verifier: verifier,
  })

  if (!data.access_token) {
    throw new Error('TikTok не вернул токен — попробуй войти ещё раз')
  }

  const account = {
    clientKey: creds.clientKey,
    clientSecret: creds.clientSecret,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    openId: data.open_id,
    expiresAt: Date.now() + (Number(data.expires_in) || 86400) * 1000,
    name: 'TikTok',
  }

  try {
    const info = await jsonRequest(
      'https://open.tiktokapis.com/v2/user/info/?fields=display_name',
      { headers: { Authorization: `Bearer ${account.accessToken}` } }
    )
    const user = info.data && info.data.user
    if (user && user.display_name) account.name = user.display_name
  } catch {}

  return account
}

async function tiktokAccess(account) {
  if (account.accessToken && account.expiresAt && account.expiresAt > Date.now() + 60000) {
    return account.accessToken
  }
  const refreshed = await refreshTiktok(account)
  Object.assign(account, refreshed)
  return refreshed.accessToken
}

async function tiktokUpload(account, file, title, onProgress) {
  const accessToken = await tiktokAccess(account)
  const size = fs.statSync(file).size
  const MAX = 64 * 1024 * 1024
  if (size > MAX) throw new Error('TikTok принимает файлы до 64 МБ за раз — уменьши качество или длину фрагмента')

  const init = await jsonRequest('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: size,
        total_chunk_count: 1,
      },
    }),
  })
  const data = init.data || {}
  if (data.error && data.error.code && data.error.code !== 'ok') {
    throw new Error(`TikTok: ${data.error.message || data.error.code}`)
  }
  const uploadUrl = data.upload_url
  const publishId = data.publish_id
  if (!uploadUrl) throw new Error('TikTok не вернул ссылку для загрузки')

  const stream = fs.createReadStream(file)
  let sent = 0
  stream.on('data', (chunk) => {
    sent += chunk.length
    if (onProgress) onProgress(Math.min(1, sent / size))
  })
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(size),
      'Content-Range': `bytes 0-${size - 1}/${size}`,
    },
    body: Readable.toWeb(stream),
    duplex: 'half',
  })
  if (!put.ok) throw new Error(`TikTok upload: ${await put.text()}`)

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const status = await jsonRequest('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({ publish_id: publishId }),
      })
      const st = (status.data && status.data.status) || ''
      if (st === 'SEND_TO_USER_INBOX') return { publish_id: publishId, draft: true }
      if (st === 'PUBLISH_COMPLETE') return { publish_id: publishId }
      if (st === 'FAILED') throw new Error('TikTok отклонил загрузку')
    } catch (err) {
      if (String(err.message).includes('отклонил')) throw err
    }
  }
  return { publish_id: publishId, pending: true }
}

/* ---------- Telegram ---------- */

function tgApi(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`
}

async function telegramJson(url, options) {
  const res = await fetch(url, options)
  let data = null
  try {
    data = await res.json()
  } catch {
    throw new Error(`Telegram: HTTP ${res.status}`)
  }
  if (!data || !data.ok) {
    const desc = (data && data.description) || `HTTP ${res.status}`
    if (res.status === 401) throw new Error('Telegram: неверный токен бота')
    throw new Error(`Telegram: ${desc}`)
  }
  return data.result
}

async function telegramConnect(creds) {
  const token = String((creds && creds.token) || '').trim()
  if (!token) throw new Error('Нужен токен бота из @BotFather')
  const me = await telegramJson(tgApi(token, 'getMe'))
  const updates = await telegramJson(tgApi(token, 'getUpdates'))
  let chat = null
  for (const update of updates || []) {
    const msg = update.message || update.edited_message || update.channel_post
    if (msg && msg.chat) chat = msg.chat
  }
  if (!chat) {
    throw new Error(`Открой в Telegram @${me.username} и напиши /start, потом нажми «Привязать» снова`)
  }
  return {
    token,
    chatId: chat.id,
    accessToken: token,
    botUsername: me.username,
    name: chat.first_name ? `${chat.first_name}` : `@${me.username}`,
  }
}

async function telegramUpload(account, file, caption, onProgress) {
  const size = fs.statSync(file).size
  if (size > 50 * 1024 * 1024) {
    throw new Error('Telegram (бот) принимает файлы до 50 МБ — для этого ролика подними CRF или сделай короче фрагмент')
  }
  if (onProgress) onProgress(0.05)
  const form = new FormData()
  form.append('chat_id', String(account.chatId))
  if (caption) form.append('caption', String(caption).slice(0, 1024))
  form.append('document', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), path.basename(file))
  const res = await fetch(tgApi(account.token, 'sendDocument'), { method: 'POST', body: form })
  if (res.status === 413) throw new Error('Файл больше 50 МБ — Telegram (бот) не принимает')
  const data = await res.json().catch(() => null)
  if (!data || !data.ok) {
    throw new Error(`Telegram: ${(data && data.description) || `HTTP ${res.status}`}`)
  }
  if (onProgress) onProgress(1)
  return data.result
}

/* ---------- storage ---------- */

class Accounts {
  constructor(file) {
    this.file = file
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}
    } catch {
      return {}
    }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2))
  }

  get(provider) {
    return this.read()[provider] || null
  }

  save(provider, account) {
    const all = this.read()
    all[provider] = account
    this.write(all)
  }

  remove(provider) {
    const all = this.read()
    delete all[provider]
    this.write(all)
  }
}

module.exports = {
  Accounts,
  youtubeConnect,
  youtubeUpload,
  tiktokConnect,
  tiktokUpload,
  telegramConnect,
  telegramUpload,
  telegramJson,
  TT_REDIRECT,
}
