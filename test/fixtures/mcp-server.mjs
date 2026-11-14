// A minimal stdio MCP server for the scan tests: answers initialize and a paginated tools/list.
// It also logs a line to stdout, which a well-behaved server shouldn't, to check the client skips it.
// Modes (argv): --collide    send a ping request and a JSON log line that reuse the client's next id first
//               --no-tools   list zero tools
//               --bad-tools  include malformed entries
//               --echo-argv  report its own argv as the server name
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const mode = new Set(args.filter((a) => a.startsWith('--')))

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
  ...(mode.has('--bad-tools') ? [null, { name: 5 }, 'x'] : []),
]

const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`)
process.stdout.write('starting fake server (a log line on stdout)\n')
const rl = createInterface({ input: process.stdin })
let waitingForPong // the tools/list request held back until the client answers our ping
const listTools = (msg) => {
  const reply = (result) => out({ jsonrpc: '2.0', id: msg.id, result })
  if (mode.has('--no-tools')) return reply({ tools: [] })
  reply(msg.params?.cursor === 'p2' ? { tools: page2 } : { tools: page1, nextCursor: 'p2' })
}
rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (!msg.method && waitingForPong && msg.id === waitingForPong.id && 'result' in msg) {
    const held = waitingForPong
    waitingForPong = undefined
    return listTools(held)
  }
  const reply = (result) => out({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.method === 'initialize') {
    const name = mode.has('--echo-argv') ? JSON.stringify(args.filter((a) => a !== '--echo-argv')) : 'fake-pay'
    reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '0' } })
  } else if (msg.method === 'tools/list') {
    if (mode.has('--collide') && !msg.params?.cursor) {
      // A structured log line and a server-to-client ping, both carrying the id the client is waiting on.
      // The list only comes once the client has answered the ping.
      out({ level: 30, id: msg.id, msg: 'listing tools' })
      out({ jsonrpc: '2.0', id: msg.id, method: 'ping' })
      waitingForPong = msg
      return
    }
    listTools(msg)
  }
})
