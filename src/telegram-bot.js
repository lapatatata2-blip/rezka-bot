'use strict'

const path = require('path')
const os = require('os')
const { telegramJson, telegramUpload } = require('./upload')
const { parseRanges } = require('./timecode')

const TEMPLATE = [
  'Форма',
  'Ссылка: https://youtu.be/…',
  'Описание: ',
  'Надпись сверху: ',
  'Таймкод: 0:10 по 1:00',
  'Субтитры: есть',
  'Качество: 1080',
  'Формат: 9:16',
  'Длительность: 60',
].join('\n')

const LABELS = [
  { key: 'url', re: /^(ссылка|сылка|сыллка|url|link)$/i },
  { key: 'description', re: /^(описание|description|desc)$/i },
  { key: 'topText', re: /^(надпись сверху|надпись|текст сверху)$/i },
  { key: 'ranges', re: /^(таймкод|таймкоды|тайм-код|тайм-коды|timecode|timecodes|тайминг)$/i },
  { key: 'subs', re: /^(субтитры|сабы|subtitles|subs)$/i },
  { key: 'quality', re: /^(качество|quality)$/i },
  { key: 'format', re: /^(формат|format|размер)$/i },
  { key: 'duration', re: /^(длительность|длина|duration)$/i },
]

function parseBotForm(text) {
  const fields = {}
  let current = null
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    // подпись может содержать пояснение в скобках, в т.ч. с двоеточием: «Формат(16:9-9:16):»
    const m = line.match(/^\s*([^:()]+?)\s*(?:\([^)]*\))?\s*:\s*(.*)$/)
    const label = m ? LABELS.find((l) => l.re.test(m[1].trim())) : null
    if (label) {
      current = label.key
      const value = m[2].trim()
      fields[current] = fields[current] ? `${fields[current]}\n${value}` : value
    } else if (current && line.trim()) {
      fields[current] += `\n${line.trim()}`
    }
  }
  return fields
}

function pickNumber(value, allowed, fallback) {
  const m = String(value || '').match(/\d+/)
  const n = m ? Number(m[0]) : NaN
  return allowed.includes(n) ? n : fallback
}

function buildJob(fields) {
  const url = String(fields.url || '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('Не вижу ссылку. Строка «Ссылка: https://…»')

  const ranges = parseRanges(fields.ranges || '')
  if (!ranges.length) throw new Error('Не понял таймкод. Пример: «Таймкод: 4:09 по 9:12»')

  const subst = String(fields.subs || '').toLowerCase().trim()
  const burn = !/^(нет|нету|no|false|0|без)/.test(subst)

  const fmt = String(fields.format || '').toLowerCase()
  const horizontal = /16\s*[:/хx]\s*9|горизонт/.test(fmt)

  return {
    url,
    ranges,
    quality: pickNumber(fields.quality, [360, 480, 720, 1080], 1080),
    orientation: horizontal ? 'horizontal' : 'vertical',
    maxChunk: pickNumber(fields.duration, [30, 45, 60], 60),
    burn,
    subLang: 'auto',
    topText: String(fields.topText || '').trim().slice(0, 120),
    description: String(fields.description || '').trim(),
  }
}

function startTelegramBot({ accounts, runJob, isBusy, getOutDir, onDone, maxRuntimeMs }) {
  let stopped = false
  let offset = 0
  let busy = false

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function sendText(account, chatId, text) {
    await telegramJson(`https://api.telegram.org/bot${account.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4000),
        disable_web_page_preview: true,
      }),
    })
  }

  async function handle(message, account) {
    const chatId = message.chat && message.chat.id
    const text = message.text || ''
    if (String(chatId) !== String(account.chatId)) {
      await sendText(account, chatId, 'Это личный бот REZKA — пришли форму из приложения, чтобы он привязался к тебе.')
      return
    }
    if (!text.trim()) {
      await sendText(account, chatId, `Пришли форму текстом:\n\n${TEMPLATE}`)
      return
    }
    if (/^\/(start|help|form|menu)\b/i.test(text.trim())) {
      await sendText(account, chatId, `Пришли форму, и я верну готовые ролики:\n\n${TEMPLATE}`)
      return
    }

    let job
    try {
      job = buildJob(parseBotForm(text))
    } catch (err) {
      await sendText(account, chatId, `${err.message}\n\n${TEMPLATE}`)
      return
    }

    if (busy || isBusy()) {
      await sendText(account, chatId, 'Уже режу другое видео — пришлю, как закончу, пришли форму ещё раз.')
      return
    }

    busy = true
    try {
      await sendText(account, chatId, 'Принял, начинаю нарезку…')
      const result = await runJob(
        {
          ...job,
          outDir: getOutDir(),
          bannerPath: null,
          bannerAt: 20,
          bannerKey: true,
          topBox: false,
          tmpBase: os.tmpdir(),
        },
        (ev) => {
          if (ev.type === 'stage' && ev.text) sendText(account, chatId, ev.text).catch(() => {})
          if (ev.type === 'plan') {
            sendText(account, chatId, `Фрагментов: ${ev.total}${ev.title ? ` · ${ev.title}` : ''}`).catch(() => {})
          }
          if (ev.type === 'warning' && ev.message) sendText(account, chatId, ev.message).catch(() => {})
        },
        { cancel: null }
      )

      let sent = 0
      for (const f of result.files) {
        const caption = [result.title, job.description].filter(Boolean).join('\n\n')
        try {
          await telegramUpload(account, f.file, caption, null)
          sent++
        } catch (err) {
          await sendText(account, chatId, `Не смог отправить ${path.basename(f.file)}: ${err.message}`)
        }
      }
      await sendText(account, chatId, sent ? `Готово: ${sent} из ${result.files.length}` : 'Готово, но файлы не отправились.')
      if (onDone) onDone(result)
    } catch (err) {
      await sendText(account, chatId, `Ошибка: ${err && err.message ? err.message : String(err)}`)
    } finally {
      busy = false
    }
  }

  async function pollOnce() {
    const account = accounts.get('telegram')
    if (!account || !account.token || !account.chatId) return
    let updates
    try {
      updates = await telegramJson(
        `https://api.telegram.org/bot${account.token}/getUpdates?timeout=25&offset=${offset}`,
        { signal: AbortSignal.timeout(35000) }
      )
    } catch (err) {
      // облачный бот на GitHub Actions может держать getUpdates — не мешаем ему
      const conflict = /conflict|terminated by other/i.test(err && err.message ? err.message : '')
      await sleep(conflict ? 60000 : 3000)
      return
    }
    for (const update of updates || []) {
      offset = Math.max(offset, update.update_id + 1)
      if (update.message) handle(update.message, account).catch(() => {})
    }
  }

  ;(async () => {
    const startedAt = Date.now()
    while (!stopped) {
      // на сервере процесс живёт ограниченное время; начатую нарезку доводим до конца
      if (maxRuntimeMs && !busy && Date.now() - startedAt > maxRuntimeMs) break
      try {
        await pollOnce()
      } catch {}
      await sleep(1000)
    }
  })()

  return {
    stop() {
      stopped = true
    },
  }
}

module.exports = { startTelegramBot, parseBotForm, buildJob, TEMPLATE }
