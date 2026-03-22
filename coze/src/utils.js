const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function readJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'))
}

function nowIso() {
  return new Date().toISOString()
}

function newTraceId() {
  return `trace_${crypto.randomBytes(8).toString('hex')}`
}

function rootPath(...parts) {
  return path.resolve(__dirname, '..', ...parts)
}

module.exports = {
  readJson,
  nowIso,
  newTraceId,
  rootPath
}
