/**
 * Minimal MCP server over stdio, used as the mount path's real counterpart.
 *
 * The mount path is only proven against a server that actually speaks MCP:
 * a stub plugin would exercise the scope plumbing while proving nothing about
 * `ctx.plugin(McpClient, config)`. This fixture registers one predictably named
 * tool so an assertion can match the `mcp__<serverName>__` prefix.
 *
 * Run: node test/composition/fixtures/mcp-server.ts
 */

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

/**
 * Build the fixture server.
 * @returns a server exposing exactly one tool, named `fixture_echo`.
 */
export function createFixtureServer(): McpServer {
  const server = new McpServer(
    { name: 'dsh-project-context-fixture', version: '1.0.0' },
    { capabilities: { tools: { listChanged: false } } },
  )
  server.registerTool('fixture_echo', {
    title: 'Echo',
    description: 'Echoes the supplied text back.',
    inputSchema: z.object({ text: z.string().describe('Text to echo') }),
  }, async args => ({ content: [{ type: 'text', text: String(args.text) }] }))
  return server
}

serveStdio(createFixtureServer)
