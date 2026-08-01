import { transmuteMcpTools, TransmuteMcpToolRuntime } from "./tools.js"
import type {
  JsonRpcId,
  JsonRpcResponse,
  JsonRpcResponseId,
  McpServerOptions,
} from "./types.js"

export const transmuteMcpProtocolVersion = "2025-11-25"
export const transmuteMcpServerName = "hraness-transmute"

const maximumMessageBytes = 1024 * 1024

interface RequestRecord {
  readonly jsonrpc: "2.0"
  readonly id?: JsonRpcId
  readonly method: string
  readonly params?: unknown
}

type LifecycleState = "new" | "initializing" | "ready"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  )
}

function isInitializeParams(value: unknown): value is Readonly<{
  protocolVersion: string
  capabilities: Readonly<Record<string, unknown>>
  clientInfo: Readonly<{ name: string; version: string }>
}> {
  return (
    isRecord(value) &&
    typeof value.protocolVersion === "string" &&
    isRecord(value.capabilities) &&
    isRecord(value.clientInfo) &&
    typeof value.clientInfo.name === "string" &&
    typeof value.clientInfo.version === "string"
  )
}

function parseRequest(value: unknown): RequestRecord {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string" ||
    value.method.length === 0 ||
    ("id" in value && !isJsonRpcId(value.id))
  ) {
    throw new Error("invalid request")
  }
  return {
    jsonrpc: "2.0",
    ...("id" in value ? { id: value.id as JsonRpcId } : {}),
    method: value.method,
    ...("params" in value ? { params: value.params } : {}),
  }
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result }
}

function failure(
  id: JsonRpcResponseId,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function parseToolCall(
  params: unknown,
): { readonly name: string; readonly argumentsValue: unknown } {
  if (
    !isRecord(params) ||
    typeof params.name !== "string" ||
    (params.arguments !== undefined && !isRecord(params.arguments))
  ) {
    throw new Error("invalid params")
  }
  const unknownKeys = Object.keys(params).filter(
    (key) => key !== "name" && key !== "arguments",
  )
  if (unknownKeys.length > 0) throw new Error("invalid params")
  return {
    name: params.name,
    argumentsValue: params.arguments ?? {},
  }
}

class TransmuteMcpSession {
  readonly runtime: TransmuteMcpToolRuntime
  readonly serverVersion: string
  state: LifecycleState = "new"

  constructor(runtime: TransmuteMcpToolRuntime, serverVersion: string) {
    this.runtime = runtime
    this.serverVersion = serverVersion
  }

  async handle(value: unknown): Promise<JsonRpcResponse | null> {
    let request: RequestRecord
    try {
      request = parseRequest(value)
    } catch {
      return failure(null, -32600, "Invalid Request")
    }

    const notification = request.id === undefined
    if (request.method === "notifications/initialized") {
      if (!notification) {
        return failure(request.id!, -32600, "Invalid Request")
      }
      if (this.state === "initializing") this.state = "ready"
      return null
    }
    if (notification) return null
    const id = request.id!

    if (request.method === "initialize") {
      if (this.state !== "new" || !isInitializeParams(request.params)) {
        return failure(id, -32602, "Invalid initialize parameters")
      }
      this.state = "initializing"
      return success(id, {
        protocolVersion: transmuteMcpProtocolVersion,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: transmuteMcpServerName,
          version: this.serverVersion,
        },
        instructions:
          "Use the compatibility check_diagram/render_diagram tools or search_transmute followed by execute_transmute with an exact registry code and typed JSON. Local paths are root-relative; source code is never accepted or evaluated.",
      })
    }

    if (this.state !== "ready") {
      return failure(id, -32002, "Server is not initialized")
    }
    if (request.method === "ping") return success(id, {})
    if (request.method === "tools/list") {
      if (
        request.params !== undefined &&
        (!isRecord(request.params) || Object.keys(request.params).length > 0)
      ) {
        return failure(id, -32602, "Invalid tools/list parameters")
      }
      return success(id, { tools: transmuteMcpTools })
    }
    if (request.method === "tools/call") {
      try {
        const toolCall = parseToolCall(request.params)
        if (!transmuteMcpTools.some((tool) => tool.name === toolCall.name)) {
          return failure(id, -32602, "Unknown tool")
        }
        return success(
          id,
          await this.runtime.call(toolCall.name, toolCall.argumentsValue),
        )
      } catch {
        return failure(id, -32602, "Invalid tools/call parameters")
      }
    }
    return failure(id, -32601, "Method not found")
  }
}

async function defaultWriteLine(line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => {
      if (error === null || error === undefined) resolve()
      else reject(error)
    })
  })
}

function defaultInput(): AsyncIterable<Uint8Array> {
  return process.stdin
}

async function emitResponse(
  writeLine: (line: string) => void | Promise<void>,
  response: JsonRpcResponse,
): Promise<void> {
  await writeLine(JSON.stringify(response))
}

async function processLine(
  line: Uint8Array,
  session: TransmuteMcpSession,
  writeLine: (line: string) => void | Promise<void>,
): Promise<void> {
  if (line.byteLength === 0) return
  let value: unknown
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(line)
    if (text.trim() === "") return
    value = JSON.parse(text)
  } catch {
    await emitResponse(writeLine, failure(null, -32700, "Parse error"))
    return
  }
  if (Array.isArray(value)) {
    await emitResponse(writeLine, failure(null, -32600, "Invalid Request"))
    return
  }
  const response = await session.handle(value)
  if (response !== null) await emitResponse(writeLine, response)
}

/**
 * Run one newline-delimited JSON-RPC MCP session. Protocol output is the only
 * stdout surface; callers that need logs must write them to stderr.
 */
export async function runMcpServer(
  options: McpServerOptions = {},
): Promise<void> {
  const runtime = await TransmuteMcpToolRuntime.create(
    options.rootDirectory ?? process.cwd(),
    options.authDependencies,
  )
  const session = new TransmuteMcpSession(
    runtime,
    options.serverVersion ?? "0.6.0",
  )
  const writeLine = options.writeLine ?? defaultWriteLine
  let buffered = Buffer.alloc(0)

  for await (const chunk of options.input ?? defaultInput()) {
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk)
    buffered = Buffer.concat([buffered, bytes])
    if (buffered.byteLength > maximumMessageBytes && !buffered.includes(0x0a)) {
      buffered = Buffer.alloc(0)
      await emitResponse(writeLine, failure(null, -32700, "Parse error"))
      continue
    }
    for (;;) {
      const newline = buffered.indexOf(0x0a)
      if (newline === -1) break
      let line = buffered.subarray(0, newline)
      buffered = buffered.subarray(newline + 1)
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
      if (line.byteLength > maximumMessageBytes) {
        await emitResponse(writeLine, failure(null, -32700, "Parse error"))
      } else {
        await processLine(line, session, writeLine)
      }
    }
  }
  if (buffered.byteLength > 0) {
    if (buffered.byteLength > maximumMessageBytes) {
      await emitResponse(writeLine, failure(null, -32700, "Parse error"))
    } else {
      await processLine(buffered, session, writeLine)
    }
  }
}
