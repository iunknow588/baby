import router from '../api_handlers/router.js'

export default async function handler(req, res) {
  return router(req, res)
}
