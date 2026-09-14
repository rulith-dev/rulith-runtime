// SPDX-License-Identifier: Apache-2.0
// Independent protocol peer: the official SDK enforces initialization and transport framing.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function localMcpServer() {
  const server = new Server({ name: 'local-mail-fixture', version: '1' }, { capabilities: { tools: {} } })
  let calls = 0
  const record = (event) => {
    if (process.env.MCP_FIXTURE_LOG) appendFileSync(process.env.MCP_FIXTURE_LOG, JSON.stringify(event) + '\n')
  }
  server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => ({
    tools: [{ name: params?.cursor ? 'mail.draft' : 'mail.read', description: 'Isolated mailbox tool',
      inputSchema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'] } }],
    ...(params?.cursor ? {} : { nextCursor: 'second-page' }),
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    record({ name: params.name, args: params.arguments, pid: process.pid })
    calls++
    if (params.name === 'mail.fail') return { isError: true, content: [{ type: 'text', text: 'Mailbox refused this operation' }] }
    if (params.name === 'mail.error-text') return { content: [{ type: 'text', text: 'error: this is the literal message subject' }] }
    if (params.name === 'mail.hang') return new Promise(() => {})
    if (params.name === 'mail.disconnect') { await server.close(); return new Promise(() => {}) }
    if (params.name === 'mail.large') return { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] }
    const rows = [{ message_id: params.arguments.message_id, subject: '订单确认', calls,
      ...(params.name === 'mail.environment' ? { secret: process.env.MAIL_FIXTURE_SECRET ?? '', leaked: Object.keys(process.env).some(k => /^RULITH_/i.test(k)) } : {}) }]
    // Text and machine data deliberately differ: only structuredContent can supply the fact mapping.
    return { content: [{ type: 'text', text: 'Message read successfully' }], structuredContent: { rows } }
  })
  return server
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stderr.write('Fixture ready; stderr is a log channel, not a protocol failure.\n')
  await localMcpServer().connect(new StdioServerTransport())
}
