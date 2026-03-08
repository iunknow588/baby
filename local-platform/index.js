const path = require('path')
const fs = require('fs')
const express = require('express')
const cors = require('cors')
const sqlite3 = require('sqlite3').verbose()

const ROOT_DIR = __dirname

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return
  const raw = fs.readFileSync(filePath, 'utf8')
  raw.split('\n').forEach(line => {
    const text = line.trim()
    if (!text || text.startsWith('#')) return
    const idx = text.indexOf('=')
    if (idx <= 0) return
    const key = text.slice(0, idx).trim()
    const value = text.slice(idx + 1).trim()
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) return
    process.env[key] = value
  })
}

loadLocalEnv(path.join(ROOT_DIR, '.env.local'))

const app = express()
const PORT = Number(process.env.PORT || 9000)
const OPENCLAW_BASE_URL = process.env.OPENCLAW_BASE_URL || 'http://127.0.0.1:5000'
const OPENCLAW_RESPONSES_PATH = '/v1/responses'
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || process.env.BABY_GATEWAY_TOKEN || ''
const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'math-doctor'
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL || 'openclaw:math-doctor'

const DATA_DIR = path.join(ROOT_DIR, 'data')
const DB_PATH = path.join(DATA_DIR, 'students.db')

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const db = new sqlite3.Database(DB_PATH)

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      student_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      age INTEGER,
      grade TEXT,
      created_at TEXT NOT NULL
    )
  `)
})

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(ROOT_DIR, 'public')))

function envelopeOk(data, traceId = '') {
  return { success: true, data, error: null, traceId }
}

function envelopeErr(code, message, traceId = '') {
  return {
    success: false,
    data: null,
    error: { code, message },
    traceId
  }
}

function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
}

function parseOpenClawText(raw) {
  if (!raw || typeof raw !== 'object') return ''
  const output = raw.output
  if (!Array.isArray(output) || output.length === 0) return ''
  const first = output[0]
  const content = first && first.content
  if (!Array.isArray(content) || content.length === 0) return ''
  const firstPart = content[0]
  if (!firstPart || typeof firstPart !== 'object') return ''
  return typeof firstPart.text === 'string' ? firstPart.text : ''
}

app.get('/', (req, res) => {
  res.json(envelopeOk({ service: 'baby-local-platform', port: PORT, status: 'up' }))
})

app.get('/health', (req, res) => {
  res.json(envelopeOk({ status: 'ok' }))
})

// Student APIs
app.post('/api/student/register', (req, res) => {
  const { name, age = null, grade = '' } = req.body || {}
  if (!name || typeof name !== 'string') {
    return res.status(400).json(envelopeErr('INVALID_PARAMS', 'name is required'))
  }

  const studentId = genId('stu')
  const now = new Date().toISOString()

  db.run(
    `INSERT INTO students (student_id, name, age, grade, created_at) VALUES (?, ?, ?, ?, ?)`,
    [studentId, name.trim(), age, grade, now],
    err => {
      if (err) {
        return res.status(500).json(envelopeErr('INTERNAL_ERROR', err.message))
      }
      res.json(
        envelopeOk({ student_id: studentId, name: name.trim(), age, grade, created_at: now })
      )
    }
  )
})

app.get('/api/student/:student_id', (req, res) => {
  const { student_id: studentId } = req.params
  db.get(
    `SELECT student_id, name, age, grade, created_at FROM students WHERE student_id = ?`,
    [studentId],
    (err, row) => {
      if (err) {
        return res.status(500).json(envelopeErr('INTERNAL_ERROR', err.message))
      }
      if (!row) {
        return res.status(404).json(envelopeErr('NOT_FOUND', 'student not found'))
      }
      res.json(envelopeOk(row))
    }
  )
})

app.get('/api/students', (req, res) => {
  db.all(`SELECT student_id, name, age, grade, created_at FROM students ORDER BY created_at DESC`, [], (err, rows) => {
    if (err) {
      return res.status(500).json(envelopeErr('INTERNAL_ERROR', err.message))
    }
    res.json(envelopeOk(rows || []))
  })
})

// Minimal placeholders for Baby frontend integration
app.get('/api/chat/rooms', (_req, res) => {
  res.json(envelopeOk({ list: [], hasMore: false }))
})

app.post('/api/chat/sessions', (_req, res) => {
  res.json(envelopeOk({ sessionId: genId('s'), roomId: genId('r') }))
})

app.post('/api/coze/chat', (req, res) => {
  const traceId = req.headers['x-trace-id'] || genId('trc')
  const message = (req.body && req.body.message) || ''
  const extra = (req.body && req.body.extra) || {}
  const agentId = (extra && extra.agentId) || OPENCLAW_AGENT_ID
  const model = (extra && extra.model) || OPENCLAW_MODEL
  const inboundAuth = (req.headers && req.headers.authorization) || ''
  const inboundToken = typeof inboundAuth === 'string' && inboundAuth.startsWith('Bearer ')
    ? inboundAuth.slice('Bearer '.length).trim()
    : ''
  const effectiveToken = OPENCLAW_TOKEN || inboundToken

  if (!message || typeof message !== 'string') {
    return res.status(400).json(envelopeErr('INVALID_PARAMS', 'message is required', traceId))
  }

  if (!effectiveToken) {
    return res.status(503).json(
      envelopeErr(
        'OPENCLAW_TOKEN_MISSING',
        'OPENCLAW_TOKEN is not configured on backend proxy',
        traceId
      )
    )
  }

  const endpoint = `${OPENCLAW_BASE_URL.replace(/\/+$/, '')}${OPENCLAW_RESPONSES_PATH}`
  const payload = {
    model,
    input: message
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)

  fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${effectiveToken}`,
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': String(agentId)
    },
    body: JSON.stringify(payload),
    signal: controller.signal
  })
    .then(async upstream => {
      clearTimeout(timer)
      const raw = await upstream.json().catch(() => ({}))
      if (!upstream.ok) {
        const statusCode = upstream.status || 502
        const message =
          (raw && raw.error && raw.error.message) ||
          `upstream error: ${upstream.status} ${upstream.statusText}`
        return res.status(statusCode).json(envelopeErr('OPENCLAW_UPSTREAM_ERROR', String(message), traceId))
      }

      const answer = parseOpenClawText(raw) || '未解析到文本回复'
      return res.json(
        envelopeOk(
          {
            chatId: genId('chat'),
            conversationId: req.body?.conversationId || genId('conv'),
            answer,
            raw
          },
          traceId
        )
      )
    })
    .catch(error => {
      clearTimeout(timer)
      const msg = error && error.name === 'AbortError' ? 'upstream timeout' : String(error?.message || error)
      return res.status(504).json(envelopeErr('OPENCLAW_CONNECT_FAILED', msg, traceId))
    })
})

app.get('/api/social/contacts', (_req, res) => {
  res.json(envelopeOk({ list: [], hasMore: false }))
})

app.get('/api/social/friend-requests', (_req, res) => {
  res.json(envelopeOk({ list: [], hasMore: false }))
})

app.post('/api/voice/upload', (_req, res) => {
  res.json(envelopeOk({ fileId: genId('f'), duration: 1.2, codec: 'audio/webm' }))
})

app.get('/api/chat/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders && res.flushHeaders()

  const timer = setInterval(() => {
    res.write(`event: heartbeat\n`)
    res.write(`data: ${JSON.stringify({ ts: Date.now(), sessionId: req.query.sessionId || '' })}\n\n`)
  }, 5000)

  req.on('close', () => {
    clearInterval(timer)
    res.end()
  })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[baby-local-platform] listening on 0.0.0.0:${PORT}`)
  console.log(`[baby-local-platform] db => ${DB_PATH}`)
  console.log(`[baby-local-platform] openclaw => ${OPENCLAW_BASE_URL}${OPENCLAW_RESPONSES_PATH}`)
  console.log(`[baby-local-platform] openclaw agent => ${OPENCLAW_AGENT_ID}, model => ${OPENCLAW_MODEL}`)
})
