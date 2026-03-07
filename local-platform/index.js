const path = require('path')
const fs = require('fs')
const express = require('express')
const cors = require('cors')
const sqlite3 = require('sqlite3').verbose()

const app = express()
const PORT = Number(process.env.PORT || 9000)

const ROOT_DIR = __dirname
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
  const message = (req.body && req.body.message) || ''
  res.json(
    envelopeOk({
      chatId: genId('chat'),
      conversationId: req.body?.conversationId || genId('conv'),
      answer: message ? `本地平台已收到: ${message}` : '本地平台已连接 Coze 占位接口',
      raw: { local: true }
    })
  )
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
})
