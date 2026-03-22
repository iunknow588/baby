const { readJson, rootPath } = require('./utils')
const { runOnce } = require('./pipeline')

async function runRegression() {
  const cases = readJson(rootPath('regression', 'cases.json'))
  const results = []

  for (const c of cases) {
    const out = await runOnce(c.message)
    const okRoute = !c.expectRoute || out.route === c.expectRoute
    const okMode = !c.expectInteractionMode || out.interactionMode === c.expectInteractionMode
    results.push({
      name: c.name,
      ok: okRoute && okMode,
      expectRoute: c.expectRoute,
      gotRoute: out.route,
      expectInteractionMode: c.expectInteractionMode,
      gotInteractionMode: out.interactionMode,
      traceId: out.traceId
    })
  }

  const pass = results.filter((r) => r.ok).length
  const fail = results.length - pass
  return { pass, fail, results }
}

module.exports = {
  runRegression
}
