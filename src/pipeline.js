'use strict'

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { spawn } = require('child_process')
const { formatTime } = require('./timecode')
const { parseSubtitleWords, buildCaptionGroups, windowGroups, buildAss } = require('./srt')

let ffmpegPath = 'ffmpeg'
try {
  const p = require('ffmpeg-static')
  if (p && fs.existsSync(p)) ffmpegPath = p
} catch {}

let ffprobePath = 'ffprobe'
try {
  const p = require('ffprobe-static').path
  if (p && fs.existsSync(p)) ffprobePath = p
} catch {}

let ytdlpPath = 'yt-dlp'
try {
  const pkgDir = path.dirname(require.resolve('youtube-dl-exec/package.json'))
  const candidate = path.join(pkgDir, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (fs.existsSync(candidate)) ytdlpPath = candidate
} catch {}

const VERTICAL = { width: 1080, height: 1920 }
const DOWNLOAD_SHARE = 40
const DOWNLOAD_CONCURRENCY = 3
const SECTION_BATCH_BYTES = Number(process.env.REZKA_SECTION_THRESHOLD) || 220 * 1024 * 1024

class CancelledError extends Error {
  constructor() {
    super('Нарезка отменена')
    this.cancelled = true
  }
}

function proxyArgs() {
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  return proxy ? ['--proxy', proxy] : []
}

function baseYtdlpArgs() {
  const args = ['--no-playlist', '--no-warnings', '--newline', '--js-runtimes', 'node', ...proxyArgs()]
  const cookies = process.env.REZKA_COOKIES_FILE
  if (cookies && fs.existsSync(cookies)) args.push('--cookies', cookies)
  return args
}

function videoFormatArgs(quality) {
  return [
    '-f',
    `bv*[ext=mp4][height<=${quality}]+ba[ext=m4a]/bv*[height<=${quality}]+ba/b[height<=${quality}]/bv*+ba/b`,
    '--merge-output-format',
    'mp4',
    '--ffmpeg-location',
    path.dirname(ffmpegPath),
    '--concurrent-fragments',
    '8',
  ]
}

function createRunner() {
  const state = { cancelled: false, children: new Set() }

  function killTree(child) {
    if (!child || child.exitCode != null) return
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch {}
    } else {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
  }

  return {
    state,
    cancel() {
      state.cancelled = true
      for (const child of state.children) killTree(child)
    },
    spawn(cmd, args, opts = {}) {
      if (state.cancelled) throw new CancelledError()
      const child = spawn(cmd, args, { windowsHide: true, ...opts })
      state.children.add(child)
      child.on('close', () => state.children.delete(child))
      return child
    },
  }
}

function runProcess(runner, cmd, args, { cwd, onStdoutLine, onStderrLine } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = runner.spawn(cmd, args, { cwd })
    } catch (err) {
      return reject(err)
    }
    let stdout = ''
    let stderr = ''
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      stdout += line + '\n'
      if (onStdoutLine) onStdoutLine(line)
    })
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      stderr += line + '\n'
      if (onStderrLine) onStderrLine(line)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (runner.state.cancelled) return reject(new CancelledError())
      resolve({ code, stdout, stderr })
    })
  })
}

function lastLines(text, count = 3) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-count)
    .join('\n')
}

function pickSubtitle(meta, pref) {
  const manual = meta.subtitles || {}
  const auto = meta.automatic_captions || {}
  const has = (obj, key) => Boolean(obj && obj[key] && obj[key].length)
  const order = pref === 'auto' ? ['ru', 'ru-orig', 'en', 'en-orig', 'uk'] : [pref, `${pref}-orig`]

  for (const lang of order) if (has(manual, lang)) return { lang, auto: false }
  for (const lang of order) if (has(auto, lang)) return { lang, auto: true }

  const anyManual = Object.keys(manual)[0]
  if (anyManual) return { lang: anyManual, auto: false }
  const anyAuto = Object.keys(auto).find((k) => !k.startsWith('live_chat'))
  if (anyAuto) return { lang: anyAuto, auto: true }
  return null
}

function planChunks(ranges, maxChunk, cues) {
  const chunks = []
  for (const range of ranges) {
    const rangeChunks = []
    let cur = range.start
    while (range.end - cur > maxChunk + 1e-6) {
      let boundary = cur + maxChunk
      if (cues.length) {
        let best = null
        for (const cue of cues) {
          if (cue.start > boundary + 1e-6) break
          if (cue.start >= boundary - 10 && cue.start > cur + 5) best = cue.start
        }
        if (best != null) boundary = best
      }
      if (boundary - cur < 5) boundary = cur + maxChunk
      rangeChunks.push({ start: cur, end: boundary })
      cur = boundary
    }
    if (range.end - cur >= 0.5) rangeChunks.push({ start: cur, end: range.end })

    // Не оставляем огрызок в конце диапазона — делим два последних куска поровну
    if (rangeChunks.length >= 2) {
      const last = rangeChunks[rangeChunks.length - 1]
      const prev = rangeChunks[rangeChunks.length - 2]
      if (last.end - last.start < Math.min(5, maxChunk / 3)) {
        let mid = prev.start + (range.end - prev.start) / 2
        if (cues.length) {
          let best = null
          let bestDiff = Infinity
          for (const cue of cues) {
            if (cue.start < prev.start + 5) continue
            if (cue.start - prev.start > maxChunk) break
            const diff = Math.abs(cue.start - mid)
            if (diff < bestDiff) {
              bestDiff = diff
              best = cue.start
            }
          }
          if (best != null && bestDiff <= 8) mid = best
        }
        prev.end = round3(mid)
        last.start = round3(mid)
      }
    }

    for (const c of rangeChunks) chunks.push({ start: round3(c.start), end: round3(c.end) })
  }
  return chunks
}

function round3(n) {
  return Math.round(n * 1000) / 1000
}

function slugify(title) {
  return (
    String(title || 'video')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 48) || 'video'
  )
}

function fileTag(seconds) {
  return formatTime(seconds).replace(/:/g, '-')
}

async function probeMedia(runner, file) {
  const res = await runProcess(runner, ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,width,height:format=duration',
    '-of',
    'json',
    file,
  ])
  if (res.code !== 0) throw new Error(`ffprobe не смог прочитать видео.\n${lastLines(res.stderr)}`)
  const data = JSON.parse(res.stdout)
  const streams = Array.isArray(data.streams) ? data.streams : []
  const stream = streams.find((s) => s.codec_type === 'video') || {}
  return {
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    duration: Number((data.format || {}).duration) || 0,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  }
}

function isImageFile(file) {
  return /\.(png|jpe?g|webp|bmp|gif)$/i.test(file)
}

async function probeBanner(runner, file) {
  if (isImageFile(file)) return { image: true, duration: 3, hasAudio: false }
  const res = await runProcess(runner, ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,width,height:format=duration',
    '-of',
    'json',
    file,
  ])
  if (res.code !== 0) return null
  const data = JSON.parse(res.stdout)
  const streams = Array.isArray(data.streams) ? data.streams : []
  const video = streams.find((s) => s.codec_type === 'video')
  if (!video) return null
  return {
    image: false,
    duration: Number((data.format || {}).duration) || 0,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  }
}

function findArtifact(tmpDir, prefix) {
  return (
    fs
      .readdirSync(tmpDir)
      .find((f) => f.startsWith(prefix) && !f.endsWith('.part') && !f.endsWith('.ytdl')) || null
  )
}

async function downloadSection(runner, url, range, quality, tmpDir, index, onProgress) {
  const args = [
    ...baseYtdlpArgs(),
    '--no-mtime',
    '--download-sections',
    `*${range.start.toFixed(3)}-${range.end.toFixed(3)}`,
    ...videoFormatArgs(quality),
    '-o',
    path.join(tmpDir, `section-${index}.%(ext)s`),
    url,
  ]
  let lastEmit = 0
  let lastPercent = -1
  const res = await runProcess(runner, ytdlpPath, args, {
    onStdoutLine(line) {
      const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/)
      if (!m) return
      const percent = Number(m[1])
      if (percent <= lastPercent) return
      lastPercent = percent
      const now = Date.now()
      if (now - lastEmit < 200) return
      lastEmit = now
      onProgress(percent / 100)
    },
  })
  if (res.code !== 0) return null
  const file = findArtifact(tmpDir, `section-${index}.`)
  return file ? path.join(tmpDir, file) : null
}

async function downloadSectionsParallel(runner, url, units, quality, tmpDir, onProgress) {
  const fracs = units.map(() => 0)
  let next = 0
  let failed = false
  const report = () => onProgress(fracs.reduce((a, b) => a + b, 0) / units.length)

  const worker = async () => {
    while (next < units.length && !failed) {
      const i = next++
      const unit = units[i]
      const file = await downloadSection(runner, url, unit, quality, tmpDir, i + 1, (frac) => {
        fracs[i] = frac
        report()
      })
      if (!file) {
        failed = true
        continue
      }
      const info = await probeMedia(runner, file)
      const span = unit.end - unit.start
      if (span > 10 && info.duration && info.duration < span - 4) {
        failed = true
        continue
      }
      unit.file = file
      unit.offset = unit.start
      unit.info = info
      fracs[i] = 1
      report()
    }
  }

  const workers = Math.min(DOWNLOAD_CONCURRENCY, units.length)
  await Promise.all(Array.from({ length: workers }, worker))
  if (failed) return null
  return units[0].info || { width: 0, height: 0, duration: 0 }
}

async function downloadFull(runner, url, quality, tmpDir, onProgress) {
  const args = [...baseYtdlpArgs(), '--no-mtime', ...videoFormatArgs(quality), '-o', path.join(tmpDir, 'video.%(ext)s'), url]
  let lastEmit = 0
  let lastPercent = -1
  const res = await runProcess(runner, ytdlpPath, args, {
    onStdoutLine(line) {
      const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/)
      if (!m) return
      const percent = Number(m[1])
      if (percent <= lastPercent) return
      lastPercent = percent
      const now = Date.now()
      if (now - lastEmit < 200) return
      lastEmit = now
      onProgress(percent / 100)
    },
  })
  if (res.code !== 0) {
    throw new Error(`Не удалось скачать видео.\n${lastLines(res.stderr)}`)
  }
  const file = findArtifact(tmpDir, 'video.')
  if (!file) throw new Error('Видеофайл не найден после скачивания.')
  return path.join(tmpDir, file)
}

function estimateFullBytes(meta, quality) {
  const formats = Array.isArray(meta.formats) ? meta.formats : []
  const video = formats
    .filter((f) => f.vcodec && f.vcodec !== 'none' && (!f.height || f.height <= quality))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))[0]
  const audio = formats
    .filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0]
  const size = (f) => {
    if (!f) return 0
    if (f.filesize) return f.filesize
    if (f.filesize_approx) return f.filesize_approx
    if (f.tbr && meta.duration) return (f.tbr * 1000 * meta.duration) / 8
    return 0
  }
  return size(video) + size(audio)
}

async function runJob(opts, emit, control) {
  const {
    url,
    ranges,
    outDir,
    quality = 1080,
    subLang = 'auto',
    burn = true,
    maxChunk = 60,
    orientation = 'vertical',
    bannerPath = null,
    bannerAt = 20,
    bannerKey = true,
    topText = '',
    topBox = false,
    tmpBase,
  } = opts

  const runner = createRunner()
  if (control) control.cancel = () => runner.cancel()
  const jobId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const tmpDir = path.join(tmpBase || require('os').tmpdir(), `rezka-${jobId}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const files = []

  async function job() {
    emit({ type: 'stage', stage: 'meta', text: 'Получаю информацию о видео…' })
    const metaRes = await runProcess(runner, ytdlpPath, [
      ...baseYtdlpArgs(),
      '--dump-single-json',
      '--skip-download',
      url,
    ])
    if (metaRes.code !== 0) {
      throw new Error(`Не удалось получить данные видео.\n${lastLines(metaRes.stderr)}`)
    }
    const meta = JSON.parse(metaRes.stdout)
    if (!meta || meta._type === 'playlist') {
      throw new Error('Похоже, это ссылка на плейлист. Нужна ссылка на одно видео.')
    }
    const title = meta.title || 'video'
    const duration = Number(meta.duration) || 0
    emit({ type: 'meta', title, duration, thumbnail: meta.thumbnail || '' })

    const validRanges = []
    for (const r of ranges) {
      const start = Math.max(0, r.start)
      const end = duration ? Math.min(r.end, duration) : r.end
      if (end - start >= 1) validRanges.push({ start, end })
    }
    if (!validRanges.length) {
      throw new Error('Тайм-коды вне длительности видео. Проверь интервал.')
    }

    let words = []
    let groups = []
    let subsFound = false
    if (burn) {
      emit({ type: 'stage', stage: 'subs', text: 'Ищу субтитры…' })
      const pick = pickSubtitle(meta, subLang)
      if (pick) {
        emit({ type: 'stage', stage: 'subs', text: `Скачиваю субтитры (${pick.lang}${pick.auto ? ', авто' : ''})…` })
        const subRes = await runProcess(runner, ytdlpPath, [
          ...baseYtdlpArgs(),
          '--skip-download',
          pick.auto ? '--write-auto-subs' : '--write-subs',
          '--sub-langs',
          pick.lang,
          '--sub-format',
          'vtt/srt/best',
          '-o',
          path.join(tmpDir, 'subs.%(ext)s'),
          url,
        ])
        const subFile = fs
          .readdirSync(tmpDir)
          .find((f) => f.startsWith('subs.') && (f.endsWith('.srt') || f.endsWith('.vtt')))
        if (subRes.code === 0 && subFile) {
          words = parseSubtitleWords(fs.readFileSync(path.join(tmpDir, subFile), 'utf8'))
          groups = buildCaptionGroups(words)
          subsFound = words.length > 0
          if (subsFound) {
            emit({
              type: 'stage',
              stage: 'subs',
              text: `Субтитры готовы: ${words.length} слов, ${groups.length} реплик (${pick.lang})`,
            })
          }
        }
        if (!subsFound) emit({ type: 'warning', message: 'Субтитры скачать не удалось — нарежу без них.' })
      } else {
        emit({ type: 'warning', message: 'У видео нет субтитров — нарежу без них.' })
      }
    }

    let banner = null
    if (bannerPath) {
      if (!fs.existsSync(bannerPath)) {
        emit({ type: 'warning', message: 'Файл баннера не найден — нарежу без баннера.' })
      } else {
        const info = await probeBanner(runner, bannerPath)
        const duration = info ? Math.min(info.image ? 3 : info.duration, 15) : 0
        if (info && duration > 0.3) {
          banner = { path: bannerPath, image: info.image, duration, hasAudio: info.hasAudio }
          emit({
            type: 'stage',
            stage: 'subs',
            text: `Баннер готов: ${info.image ? 'картинка, 3 сек' : `видео, ${duration.toFixed(1)} сек`}`,
          })
        } else {
          emit({ type: 'warning', message: 'Не удалось прочитать баннер — нарежу без баннера.' })
        }
      }
    }

    const plans = validRanges.map((range) => ({
      range,
      chunks: planChunks([range], banner ? Math.max(10, maxChunk - banner.duration) : maxChunk, words),
    }))

    let globalIndex = 0
    const allChunks = []
    for (const plan of plans) {
      for (const chunk of plan.chunks) {
        allChunks.push(chunk)
      }
    }
    // нумерация всегда по порядку в видео, даже если тайм-коды введены вразнобой
    allChunks.sort((a, b) => a.start - b.start)
    for (const chunk of allChunks) chunk.index = ++globalIndex
    const totalChunks = allChunks.length
    emit({
      type: 'plan',
      title,
      total: totalChunks,
      chunks: allChunks.map((c) => ({ index: c.index, start: c.start, end: c.end })),
    })

    const estimatedBytes = estimateFullBytes(meta, quality)
    const downloadWhole = !estimatedBytes || estimatedBytes <= SECTION_BATCH_BYTES
    let videoInfo = null

    if (downloadWhole) {
      emit({ type: 'stage', stage: 'download', text: 'Качаю видео целиком — так быстрее…' })
      const fullPath = await downloadFull(runner, url, quality, tmpDir, (frac) => {
        emit({ type: 'progress', percent: frac * DOWNLOAD_SHARE })
      })
      videoInfo = await probeMedia(runner, fullPath)
      for (const chunk of allChunks) {
        chunk.file = fullPath
        chunk.offset = 0
        chunk.info = videoInfo
      }
    } else {
      emit({
        type: 'stage',
        stage: 'download',
        text: `Скачиваю только нужные куски (по ${DOWNLOAD_CONCURRENCY} параллельно)…`,
      })
      const info = await downloadSectionsParallel(runner, url, allChunks, quality, tmpDir, (frac) => {
        emit({ type: 'progress', percent: frac * DOWNLOAD_SHARE })
      })
      if (info) {
        videoInfo = info
      } else {
        for (const chunk of allChunks) chunk.file = null
        emit({ type: 'stage', stage: 'download', text: 'Качаю видео целиком (так надёжнее)…' })
        const fullPath = await downloadFull(runner, url, quality, tmpDir, (frac) => {
          emit({ type: 'progress', percent: frac * DOWNLOAD_SHARE })
        })
        videoInfo = await probeMedia(runner, fullPath)
        for (const chunk of allChunks) {
          chunk.file = fullPath
          chunk.offset = 0
          chunk.info = videoInfo
        }
      }
    }

    const vertical = orientation === 'vertical'
    const frameW = vertical ? VERTICAL.width : Math.max(2, videoInfo.width || 1920)
    const frameH = vertical ? VERTICAL.height : Math.max(2, videoInfo.height || 1080)

    const slug = slugify(title)
    const absoluteOutDir = path.resolve(outDir)
    fs.mkdirSync(absoluteOutDir, { recursive: true })

    emit({ type: 'stage', stage: 'cut', text: 'Нарезаю фрагменты…' })
    emit({ type: 'progress', percent: DOWNLOAD_SHARE })

    let processed = 0
    for (const chunk of allChunks) {
      const index = String(chunk.index).padStart(2, '0')
      const dur = chunk.end - chunk.start
      const bDur = banner ? banner.duration : 0
      const bannerActive = Boolean(banner) && bDur > 0.3 && dur > bannerAt + 1
      const outDur = bannerActive ? dur + bDur : dur

      const outName = `${slug}_${index}_${fileTag(chunk.start)}-${fileTag(chunk.end)}.mp4`
      const outPath = path.join(absoluteOutDir, outName)

      let assRel = null
      const chunkGroups =
        burn && groups.length ? windowGroups(groups, chunk.start, chunk.end) : []
      const overlayText = String(topText || '').trim().slice(0, 120)
      if (chunkGroups.length || overlayText) {
        assRel = `chunk-${index}.ass`
        const shift = bannerActive ? { at: bannerAt, by: bDur } : null
        fs.writeFileSync(
          path.join(tmpDir, assRel),
          buildAss(chunkGroups, frameW, frameH, shift, overlayText, topBox),
          'utf8'
        )
      }

      emit({ type: 'chunk', index: chunk.index, status: 'run' })

      const seek = Math.max(0, chunk.start - chunk.offset)
      const ffArgs = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        seek.toFixed(3),
        '-t',
        dur.toFixed(3),
        '-i',
        chunk.file,
      ]

      if (bannerActive) {
        const bDurStr = bDur.toFixed(3)
        const atStr = bannerAt.toFixed(3)
        const hasAudio = Boolean(chunk.info && chunk.info.hasAudio)
        let audioSrc = null

        if (banner.image) {
          ffArgs.push('-loop', '1', '-framerate', '30', '-t', bDurStr, '-i', banner.path)
          if (hasAudio) {
            ffArgs.push('-f', 'lavfi', '-t', bDurStr, '-i', 'anullsrc=r=48000:cl=stereo')
            audioSrc = '2:a'
          }
        } else {
          ffArgs.push('-i', banner.path)
          if (hasAudio) {
            if (banner.hasAudio) {
              audioSrc = '1:a'
            } else {
              ffArgs.push('-f', 'lavfi', '-t', bDurStr, '-i', 'anullsrc=r=48000:cl=stereo')
              audioSrc = '2:a'
            }
          }
        }

        const bannerW = Math.round(frameW * 0.6)
        const bannerChain = bannerKey
          ? `[1:v]chromakey=0x00FF00:0.30:0.10,scale=${bannerW}:-2[banner]`
          : `[1:v]scale=${bannerW}:-2[banner]`
        const chains = []
        if (vertical) {
          chains.push(
            '[0:v]split=2[bg][fg]',
            `[bg]scale=270:480:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=270:480,gblur=sigma=8,scale=${frameW}:${frameH}:flags=bilinear,setsar=1,eq=brightness=-0.06[bgv]`,
            `[fg]scale=${frameW}:${frameH}:force_original_aspect_ratio=decrease,setsar=1[fgv]`,
            '[bgv][fgv]overlay=(W-w)/2:(H-h)/2:shortest=1[comp]'
          )
        } else {
          chains.push('[0:v]setpts=PTS-STARTPTS[comp]')
        }
        chains.push(
          '[comp]split=3[ch][cf][ct]',
          `[ch]trim=start=0:end=${atStr},setpts=PTS-STARTPTS[head]`,
          `[cf]trim=start=${atStr}:end=${(bannerAt + 0.04).toFixed(3)},setpts=PTS-STARTPTS,loop=loop=-1:size=1,trim=duration=${bDurStr}[freeze]`,
          `[ct]trim=start=${atStr},setpts=PTS-STARTPTS[tail]`,
          bannerChain,
          '[freeze][banner]overlay=(W-w)/2:(H-h)/2:eof_action=pass[fr]',
          '[head][fr][tail]concat=n=3:v=1:a=0[vcat]',
          assRel ? `[vcat]ass=${assRel},format=yuv420p[v]` : '[vcat]format=yuv420p[v]'
        )
        if (audioSrc) {
          chains.push(
            '[0:a]asplit[ah][at]',
            `[ah]atrim=start=0:end=${atStr},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1]`,
            `[at]atrim=start=${atStr},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a3]`,
            `[${audioSrc}]atrim=duration=${bDurStr},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a2]`,
            '[a1][a2][a3]concat=n=3:v=0:a=1[aout]'
          )
        }
        ffArgs.push('-filter_complex', chains.join(';'), '-map', '[v]')
        if (audioSrc) ffArgs.push('-map', '[aout]')
      } else if (vertical) {
        const chains = [
          '[0:v]split=2[bg][fg]',
          `[bg]scale=270:480:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=270:480,gblur=sigma=8,scale=${frameW}:${frameH}:flags=bilinear,setsar=1,eq=brightness=-0.06[bgv]`,
          `[fg]scale=${frameW}:${frameH}:force_original_aspect_ratio=decrease,setsar=1[fgv]`,
          '[bgv][fgv]overlay=(W-w)/2:(H-h)/2:shortest=1[comp]',
          `[comp]${assRel ? `ass=${assRel},` : ''}format=yuv420p[v]`,
        ]
        ffArgs.push('-filter_complex', chains.join(';'), '-map', '[v]', '-map', '0:a?')
      } else if (assRel) {
        ffArgs.push('-vf', `ass=${assRel}`)
      }

      ffArgs.push(
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        '-nostats',
        outPath
      )

      const chunkRes = await runProcess(runner, ffmpegPath, ffArgs, {
        cwd: tmpDir,
        onStdoutLine(line) {
          const m = line.match(/^out_time_us=(\d+)/)
          if (!m) return
          const frac = Math.min(1, Number(m[1]) / 1e6 / outDur)
          emit({
            type: 'progress',
            percent: DOWNLOAD_SHARE + ((processed + frac) / totalChunks) * (100 - DOWNLOAD_SHARE),
          })
        },
      })
      if (chunkRes.code !== 0) {
        throw new Error(`ffmpeg не смог обработать фрагмент ${index}.\n${lastLines(chunkRes.stderr)}`)
      }

      files.push({ file: outPath })
      emit({ type: 'chunk', index: chunk.index, status: 'done', file: outPath })
      processed++
      emit({
        type: 'progress',
        percent: DOWNLOAD_SHARE + (processed / totalChunks) * (100 - DOWNLOAD_SHARE),
      })
    }

    emit({ type: 'done', title, files, outDir: absoluteOutDir, count: files.length, subs: subsFound })
    return { title, files, outDir: absoluteOutDir }
  }

  try {
    return await job()
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  }
}

module.exports = { runJob, planChunks, pickSubtitle, createRunner, CancelledError }
