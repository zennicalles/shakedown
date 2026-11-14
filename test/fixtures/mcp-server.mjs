// A minimal stdio MCP server for the scan tests: answers initialize and a paginated tools/list.
// It also logs a line to stdout, which a well-behaved server shouldn't, to check the client skips it.
import { createInterface } from 'node:readline'

const page1 = [
  {
    name: 'create_refund',
    description: 'Refund a capture.',
    inputSchema: { type: 'object', properties: { capture_id: { type: 'string' }, amount: { type: 'string' } } },
  },
  { name: 'get_refund', description: 'Get a refund.', inputSchema: { type: 'object', properties: { refund_id: { type: 'string' } } } },
]
const page2 = [
  {
    name: 'send-email',
    description: 'Send an email.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        idempotencyKey: { type: 'string', description: 'Use the same key when retrying the same logical email.' },
      },
    },
  },
]

process.stdout.write('starting fake server (a log line on stdout)\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
  if (msg.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-pay', version: '0' } })
  else if (msg.method === 'tools/list') reply(msg.params?.cursor === 'p2' ? { tools: page2 } : { tools: page1, nextCursor: 'p2' })
})
