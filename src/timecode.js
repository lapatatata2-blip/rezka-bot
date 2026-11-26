'use strict'

function parseTimeToSeconds(input) {
  const parts = String(input).trim().split(':')
  if (parts.length < 2 || parts.length > 3) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  let total = 0
  for (const n of nums) total = total * 60 + n
  return total
}

const RANGE_RE =
  /(\d{1,3}(?::\d{1,2}){1,2})\s*(?:-+|–|—|по|to|до|\.\.\.|…)\s*(\d{1,3}(?::\d{1,2}){1,2})/gi

function parseRanges(text) {
  const ranges = []
  if (!text) return ranges
  for (const m of String(text).matchAll(RANGE_RE)) {
    const start = parseTimeToSeconds(m[1])
    const end = parseTimeToSeconds(m[2])
    if (start == null || end == null || end <= start) continue
    ranges.push({ start, end })
  }
  return ranges
}

function formatTime(totalSeconds) {
  const t = Math.max(0, Math.round(totalSeconds))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':')
}

function formatSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const rest = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rest).padStart(3, '0')}`
}

const api = { parseTimeToSeconds, parseRanges, formatTime, formatSrtTime }

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.RezkaTime = api
