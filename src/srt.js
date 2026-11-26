'use strict'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

function decodeEntities(text) {
  return text.replace(/&(#?\w+);/g, (m, name) => (ENTITIES[name] !== undefined ? ENTITIES[name] : m))
}

function cleanWord(text) {
  return decodeEntities(String(text).replace(/<[^>]+>/g, '')).replace(/\u200b/g, '').trim()
}

const CUE_TIME_RE = /(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})/
const INLINE_TIME_RE = /<(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})>/

function parseTimestamp(value) {
  const m = String(value).match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
}

function tokenizeLine(line, cueStart) {
  const tokens = []
  let currentTime = null
  const re = /<(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})>|<c(?:\.[^>]*)?>([\s\S]*?)<\/c>|([^<]+)/gi
  let match
  while ((match = re.exec(line))) {
    if (match[1] !== undefined) {
      currentTime = parseTimestamp(`${match[1]}:${match[2]}:${match[3]}.${match[4]}`)
    } else if (match[5] !== undefined) {
      const text = cleanWord(match[5])
      if (text) tokens.push({ text, time: currentTime })
    } else if (match[6] !== undefined) {
      for (const part of match[6].split(/\s+/)) {
        const text = cleanWord(part)
        if (text) tokens.push({ text, time: currentTime })
      }
    }
  }
  return tokens.map((t) => ({ text: t.text, time: t.time == null ? cueStart : t.time }))
}

/**
 * Разбирает VTT/SRT в список слов с абсолютными таймингами.
 * YouTube авто-субтитры содержат пословные тайминги в тегах <00:00:04.760>,
 * а повтор предыдущей строки (rolling) приходит обычным текстом — его игнорируем.
 */
function parseSubtitleWords(raw) {
  const text = String(raw).replace(/\r/g, '').replace(/^\uFEFF/, '')
  const words = []

  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n')
    const timeIdx = lines.findIndex((l) => l.includes('-->'))
    if (timeIdx === -1) continue
    const m = lines[timeIdx].match(CUE_TIME_RE)
    if (!m) continue
    const start = parseTimestamp(m[1])
    const end = parseTimestamp(m[2])
    if (start == null || end == null || end <= start) continue

    const body = lines.slice(timeIdx + 1)
    let taggedIdx = -1
    for (let i = body.length - 1; i >= 0; i--) {
      if (INLINE_TIME_RE.test(body[i])) {
        taggedIdx = i
        break
      }
    }

    if (taggedIdx >= 0) {
      for (const token of tokenizeLine(body[taggedIdx], start)) {
        words.push({ start: Math.max(0, token.time), text: token.text })
      }
      continue
    }

    // сервисные «вспышки» YouTube (0.01 c) дублируют уже показанную строку
    if (end - start < 0.25) continue

    const content = decodeEntities(body.join('\n').replace(/<[^>]+>/g, '')).replace(/\u200b/g, '')
    const parts = content.split(/\s+/).filter(Boolean)
    if (!parts.length) continue
    for (let i = 0; i < parts.length; i++) {
      words.push({ start: start + ((end - start) * i) / parts.length, text: parts[i] })
    }
  }

  words.sort((a, b) => a.start - b.start)
  const result = []
  for (const word of words) {
    const prev = result[result.length - 1]
    if (prev && prev.text === word.text && Math.abs(prev.start - word.start) < 0.06) continue
    result.push(word)
  }
  return result
}

function isSentenceEnd(text) {
  return /[.!?…]["'»)]?$/.test(text)
}

/**
 * Группирует слова в короткие реплики (одно предложение / до 5 слов),
 * проставляет тайминг показа каждой реплики так, чтобы они не пересекались.
 */
function buildCaptionGroups(words, options = {}) {
  const maxWords = options.maxWords || 5
  const maxDur = options.maxDur || 3.4
  const gapBreak = options.gapBreak || 0.9

  const groups = []
  let current = []
  const flush = () => {
    if (current.length) {
      groups.push({ words: current })
      current = []
    }
  }

  for (const word of words) {
    if (current.length) {
      const prev = current[current.length - 1]
      const tooFar = word.start - prev.start > gapBreak
      const tooLong = word.start - current[0].start > maxDur
      if (tooFar || tooLong || current.length >= maxWords) flush()
    }
    current.push({ ...word })
    if (isSentenceEnd(word.text)) flush()
  }
  flush()

  for (let gi = 0; gi < groups.length; gi++) {
    const groupWords = groups[gi].words
    const nextStart = gi + 1 < groups.length ? groups[gi + 1].words[0].start : Infinity
    for (let wi = 0; wi < groupWords.length; wi++) {
      const word = groupWords[wi]
      const isLast = wi === groupWords.length - 1
      let end
      if (isLast) {
        end = Math.min(word.start + 1.0, nextStart - 0.12)
      } else {
        end = Math.min(groupWords[wi + 1].start, nextStart - 0.05)
      }
      if (end <= word.start) end = word.start + 0.1
      word.playStart = word.start
      word.playEnd = end
    }
    // не даём репликам наложиться друг на друга
    if (gi + 1 < groups.length) {
      const next = groups[gi + 1].words[0]
      const last = groupWords[groupWords.length - 1]
      if (last.playEnd > next.playStart) {
        last.playEnd = Math.max(last.playStart + 0.1, next.playStart - 0.12)
      }
    }
  }

  return groups
}

function windowGroups(groups, start, end) {
  const result = []
  for (const group of groups) {
    const groupStart = group.words[0].playStart
    const groupEnd = group.words[group.words.length - 1].playEnd
    if (groupEnd <= start + 0.01 || groupStart >= end - 0.01) continue

    const words = []
    for (const word of group.words) {
      const ws = Math.max(word.playStart, start)
      const we = Math.min(word.playEnd, end)
      if (we - ws < 0.03) continue
      words.push({ text: word.text, playStart: ws - start, playEnd: we - start })
    }
    if (words.length) result.push({ words })
  }
  return result
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

function escapeAss(text) {
  return String(text).replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, '\\N')
}

const ACTIVE_COLOR = '\\1c&HFF6BB2&'
const BASE_COLOR = '\\1c&HFFFFFF&'

/**
 * ASS с караоке-подсветкой: слово, которое звучит сейчас, заливается фиолетовым.
 * На экране всегда ровно одна реплика — старые не липнут поверх новых.
 * shift = { at, by } сдвигает субтитры после вставки баннера.
 */
function buildAss(groups, width, height, shift, topText, topBox) {
  const vertical = height > width
  const fontSize = Math.round(height * (vertical ? 0.045 : 0.05))
  const outline = Math.max(2, Math.round(fontSize * 0.075))
  const marginLR = Math.round(width * (vertical ? 0.075 : 0.06))
  const marginV = Math.round(height * (vertical ? 0.13 : 0.06))

  const style = `Style: Default,Segoe UI,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${outline},0,2,${marginLR},${marginLR},${marginV},1`

  const topFont = Math.round(height * (vertical ? 0.05 : 0.045))
  // надпись сидит ниже верхней кромки, но остаётся в верхней трети кадра
  const topMarginV = Math.round(height * (vertical ? 0.08 : 0.05))
  const topStyle = topBox
    ? `Style: Top,Segoe UI,${topFont},&H00FFFFFF,&H00FFFFFF,&H00F755A8,&H00F755A8,1,0,0,0,100,100,0,0,3,${Math.max(6, Math.round(topFont * 0.35))},0,8,${marginLR},${marginLR},${topMarginV},1`
    : `Style: Top,Segoe UI,${topFont},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(topFont * 0.08))},1,8,${marginLR},${marginLR},${topMarginV},1`

  const events = []
  if (topText) {
    events.push(`Dialogue: 1,0:00:00.00,9:59:59.00,Top,,0,0,0,,${escapeAss(topText)}`)
  }
  for (const group of groups) {
    const words = group.words
    const texts = words.map((w) => escapeAss(w.text))
    const lastEnd = words[words.length - 1].playEnd

    for (let i = 0; i < words.length; i++) {
      let ws = words[i].playStart
      let we
      if (i + 1 < words.length) {
        const nextStart = words[i + 1].playStart
        we = nextStart > ws ? nextStart : ws + 0.05
      } else {
        we = Math.max(lastEnd, ws + 0.1)
      }
      if (shift) {
        if (ws >= shift.at) {
          ws += shift.by
          we += shift.by
        } else if (we > shift.at) {
          we = shift.at
        }
      }
      if (we <= ws) continue
      const parts = texts.map((text, idx) =>
        idx === i ? `{${ACTIVE_COLOR}}${text}{${BASE_COLOR}}` : text
      )
      events.push(`Dialogue: 0,${assTime(ws)},${assTime(we)},Default,,0,0,0,,${parts.join(' ')}`)
    }
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style,
    topStyle,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n')
}

module.exports = {
  parseSubtitleWords,
  buildCaptionGroups,
  windowGroups,
  buildAss,
}
