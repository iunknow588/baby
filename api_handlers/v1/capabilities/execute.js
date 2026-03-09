import { listCapabilities, runCapability } from '../../_lib/capabilities.js'
import { fail, methodNotAllowed, ok, readJson } from '../../_lib/http.js'
import { makeId, nowIso } from '../../_lib/platform-chat.js'
import { supabaseInsert } from '../../_lib/supabase.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res)

  try {
    const body = await readJson(req)
    const capabilityKey = typeof body.capabilityKey === 'string' ? body.capabilityKey.trim() : ''
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''
    const inputEnvelope = body.inputEnvelope && typeof body.inputEnvelope === 'object' ? body.inputEnvelope : {}

    if (!capabilityKey) {
      return fail(res, 400, 'INVALID_CAPABILITY_KEY', 'capabilityKey is required')
    }

    const executionId = makeId('cap')
    const outputEnvelope = await runCapability(capabilityKey, inputEnvelope, { conversationId })

    try {
      await supabaseInsert(
        'capability_runs',
        {
          id: executionId,
          capability_key: capabilityKey,
          conversation_id: conversationId || null,
          input_envelope: inputEnvelope,
          output_envelope: outputEnvelope,
          status: 'succeeded',
          created_at: nowIso()
        },
        'minimal'
      )
    } catch (_error) {
      // ignore when table does not exist
    }

    return ok(res, {
      executionId,
      capabilityKey,
      status: 'succeeded',
      availableCapabilities: listCapabilities(),
      outputEnvelope
    })
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 500
    const code = typeof error?.code === 'string' ? error.code : 'CAPABILITY_EXECUTION_FAILED'
    if (status < 500) {
      return fail(res, status, code, error.message || 'capability execution failed')
    }
    return fail(res, 500, 'CAPABILITY_EXECUTION_FAILED', error.message || 'capability execution failed')
  }
}
