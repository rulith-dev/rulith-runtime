// SPDX-License-Identifier: Apache-2.0
// Small malformed-response fixture. Successful interoperability uses the independent SDK server.
export function mcpHttpHandler(answer) {
  return async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405); res.end(); return }
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString())
    if (!Object.hasOwn(request, 'id')) { res.writeHead(202); res.end(); return }
    res.setHeader('content-type', 'application/json')
    if (request.method === 'initialize') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
      } })); return
    }
    await answer(request, res)
  }
}
