import { Hono } from 'hono'
import { serve } from '@hono/node-server'

const app = new Hono()

app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'opencode' })
})

const port = 4100
console.log(`opencode listening on port ${port}`)

serve({ fetch: app.fetch, port })
