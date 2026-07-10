import { Hono } from 'hono'
import { serve } from '@hono/node-server'

const app = new Hono()

app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'contractor' })
})

const port = 4100
console.log(`contractor listening on port ${port}`)

serve({ fetch: app.fetch, port })
