import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import { WebSocketServer, WebSocket } from "ws"
import { z } from "zod"
import { randomUUID } from "node:crypto"

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const ROOM_CODE_LENGTH = 6
const MAX_PLAYERS = 10
const MAX_ROOM_LIFETIME_MS = 24 * 60 * 60 * 1000
const MAX_ROOM_LIFETIME_CLEANUP_MS = 60 * 60 * 1000
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX = 10

type Player = {
  id: string
  token: string
  name: string
  avatarColor: string
  avatarText: string
  isHost: boolean
  joinedAt: number
}

type Room = {
  code: string
  hostId: string
  players: Player[]
  state: "lobby" | "prompt" | "assigned" | "round" | "finished" | "voting" | "reveal" | "podium"
  createdAt: number
  lastActivity: number
}

type RoomClient = {
  ws: WebSocket
  playerId: string
  code: string
}

type PromptPhase = {
  submissions: Map<string, string>
  assignments: Map<string, string>
  startedAt: number
  endsAt: number
  timeout: NodeJS.Timeout | null
  tick: NodeJS.Timeout | null
}

type MainPhase = {
  startedAt: number
  endsAt: number
  timeout: NodeJS.Timeout | null
  tick: NodeJS.Timeout | null
}

const PROMPT_DURATION_MS = 60 * 1000
const MAIN_DURATION_MS = 3 * 60 * 1000
const PROMPT_MAX_LEN = 80

const rooms = new Map<string, Room>()
const roomSockets = new Map<string, Set<RoomClient>>()
const rateLimitByIp = new Map<string, number[]>()
const countdowns = new Map<string, NodeJS.Timeout[]>()
const promptPhases = new Map<string, PromptPhase>()
const mainPhases = new Map<string, MainPhase>()

const PlayerInputSchema = z.object({
  name: z.string().trim().min(1).max(20),
  avatarColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  avatarText: z.string().trim().min(1).max(3),
})

const RoomCodeSchema = z.string().regex(/^[A-Z0-9]{6}$/)

function generateRoomCode(): string {
  let out = ""
  const alphabetLen = ROOM_CODE_ALPHABET.length
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const idx = Math.floor(Math.random() * alphabetLen)
    out += ROOM_CODE_ALPHABET[idx]
  }
  return out
}

function generateUniqueRoomCode(): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateRoomCode()
    if (!rooms.has(code)) return code
  }
  throw new Error("ROOM_CODE_COLLISION")
}

function isExpired(room: Room): boolean {
  return Date.now() - room.createdAt >= MAX_ROOM_LIFETIME_MS
}

function publicRoomPayload(room: Room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatarColor: p.avatarColor,
      avatarText: p.avatarText,
      isHost: p.isHost,
      joinedAt: p.joinedAt,
    })),
    state: room.state,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
  }
}

function broadcastRoomUpdate(code: string) {
  const room = rooms.get(code)
  if (!room) return
  const payload = JSON.stringify({ t: "room:update", room: publicRoomPayload(room) })
  const clients = roomSockets.get(code)
  if (!clients) return
  for (const c of clients) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(payload)
  }
}

function broadcastRoomExpired(code: string, reason: string) {
  const clients = roomSockets.get(code)
  if (!clients) return
  const payload = JSON.stringify({ t: "room:expired", code, reason })
  for (const c of clients) {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(payload)
      c.ws.close(4000, reason)
    }
  }
}

function broadcastToRoom(code: string, payload: unknown) {
  const clients = roomSockets.get(code)
  if (!clients) return
  const raw = JSON.stringify(payload)
  for (const c of clients) {
    if (c.ws.readyState === WebSocket.OPEN) {
      try {
        c.ws.send(raw)
      } catch {}
    }
  }
}

function clearCountdown(code: string) {
  const timers = countdowns.get(code)
  if (!timers) return
  for (const t of timers) clearTimeout(t)
  countdowns.delete(code)
}

function clearPrompt(code: string) {
  const phase = promptPhases.get(code)
  if (!phase) return
  if (phase.timeout) clearTimeout(phase.timeout)
  if (phase.tick) clearInterval(phase.tick)
  promptPhases.delete(code)
}

function clearMainPhase(code: string) {
  const phase = mainPhases.get(code)
  if (!phase) return
  if (phase.timeout) clearTimeout(phase.timeout)
  if (phase.tick) clearInterval(phase.tick)
  mainPhases.delete(code)
}

function shuffleArray<T>(arr: T[]): T[] {
  const next = [...arr]
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = next[i]!
    next[i] = next[j]!
    next[j] = tmp
  }
  return next
}

function buildDerangedAssignments(submissions: Map<string, string>, playerIds: string[]): Map<string, string> {
  const submittedIds = [...submissions.keys()]
  const submittedEntries = [...submissions.entries()]
  if (submittedEntries.length === 0) {
    const empty = new Map<string, string>()
    for (const pid of playerIds) empty.set(pid, "")
    return empty
  }
  if (submittedEntries.length === 1) {
    const soleText = submittedEntries[0]![1]
    const soleId = submittedEntries[0]![0]
    const out = new Map<string, string>()
    for (const pid of playerIds) {
      if (pid === soleId) out.set(pid, "")
      else out.set(pid, soleText)
    }
    return out
  }
  const ids = submittedIds
  const texts = submittedEntries.map(([, t]) => t)
  let shuffled: string[] = []
  let attempts = 0
  while (attempts < 80) {
    shuffled = shuffleArray(texts)
    let valid = true
    for (let i = 0; i < ids.length; i++) {
      const ownerId = ids[i]!
      const assigned = shuffled[i]!
      if (submissions.get(ownerId) === assigned) {
        valid = false
        break
      }
    }
    if (valid) break
    attempts++
  }
  if (attempts >= 80) {
    shuffled = [...texts]
    const last = shuffled[shuffled.length - 1]!
    shuffled.pop()
    shuffled.unshift(last)
  }
  const idToAssigned = new Map<string, string>()
  for (let i = 0; i < ids.length; i++) {
    idToAssigned.set(ids[i]!, shuffled[i]!)
  }
  const result = new Map<string, string>()
  for (const pid of playerIds) {
    if (idToAssigned.has(pid)) {
      result.set(pid, idToAssigned.get(pid)!)
    } else {
      const pool = submittedEntries.filter(([id]) => id !== pid).map(([, t]) => t)
      const source = pool.length ? pool : texts
      const pick = source[Math.floor(Math.random() * source.length)]!
      result.set(pid, pick)
    }
  }
  return result
}

function broadcastPromptProgress(code: string) {
  const room = rooms.get(code)
  const phase = promptPhases.get(code)
  if (!room || !phase) return
  const x = phase.submissions.size
  const y = room.players.length
  broadcastToRoom(code, { t: "game:prompt:progress", x, y })
}

function startMainTimer(code: string) {
  const room = rooms.get(code)
  if (!room) return
  if (mainPhases.has(code)) return
  room.state = "round"
  touchRoom(room)
  broadcastRoomUpdate(code)
  const now = Date.now()
  const phase: MainPhase = {
    startedAt: now,
    endsAt: now + MAIN_DURATION_MS,
    timeout: null,
    tick: null,
  }
  mainPhases.set(code, phase)
  broadcastToRoom(code, { t: "game:main:start", durationMs: MAIN_DURATION_MS, msLeft: MAIN_DURATION_MS })
  phase.tick = setInterval(() => {
    const p = mainPhases.get(code)
    const r = rooms.get(code)
    if (!p || !r) {
      if (p?.tick) clearInterval(p.tick)
      return
    }
    const msLeft = Math.max(0, p.endsAt - Date.now())
    broadcastToRoom(code, { t: "game:main:tick", msLeft, durationMs: MAIN_DURATION_MS })
    if (msLeft <= 0) {
      if (p.tick) clearInterval(p.tick)
      p.tick = null
    }
  }, 500)
  phase.timeout = setTimeout(() => {
    endMainTimer(code)
  }, MAIN_DURATION_MS + 500)
}

function endMainTimer(code: string) {
  const room = rooms.get(code)
  const phase = mainPhases.get(code)
  if (!room || !phase) return
  if (phase.tick) clearInterval(phase.tick)
  if (phase.timeout) clearTimeout(phase.timeout)
  mainPhases.delete(code)
  room.state = "finished"
  touchRoom(room)
  broadcastRoomUpdate(code)
  broadcastToRoom(code, { t: "game:main:end" })
}

function endPromptPhase(code: string) {
  const room = rooms.get(code)
  const phase = promptPhases.get(code)
  if (!room || !phase) return
  if (phase.tick) clearInterval(phase.tick)
  if (phase.timeout) clearTimeout(phase.timeout)
  phase.tick = null
  phase.timeout = null
  const playerIds = room.players.map((p) => p.id)
  const assignments = buildDerangedAssignments(phase.submissions, playerIds)
  phase.assignments = assignments
  room.state = "assigned"
  touchRoom(room)
  broadcastRoomUpdate(code)
  const clients = roomSockets.get(code)
  if (clients) {
    for (const c of clients) {
      if (c.ws.readyState === WebSocket.OPEN) {
        const assignedText = assignments.get(c.playerId) ?? ""
        try {
          c.ws.send(JSON.stringify({ t: "game:prompt:result", assignedText }))
        } catch {}
      }
    }
  }
  broadcastToRoom(code, { t: "game:prompt:done", msLeft: 0 })
  startMainTimer(code)
}

function startPromptPhase(code: string) {
  const room = rooms.get(code)
  if (!room) return
  if (promptPhases.has(code)) return
  room.state = "prompt"
  touchRoom(room)
  broadcastRoomUpdate(code)
  const now = Date.now()
  const phase: PromptPhase = {
    submissions: new Map(),
    assignments: new Map(),
    startedAt: now,
    endsAt: now + PROMPT_DURATION_MS,
    timeout: null,
    tick: null,
  }
  promptPhases.set(code, phase)
  broadcastToRoom(code, { t: "game:prompt:start", durationMs: PROMPT_DURATION_MS, total: room.players.length, msLeft: PROMPT_DURATION_MS })
  broadcastPromptProgress(code)
  phase.tick = setInterval(() => {
    const p = promptPhases.get(code)
    const r = rooms.get(code)
    if (!p || !r) {
      if (p?.tick) clearInterval(p.tick)
      return
    }
    const msLeft = Math.max(0, p.endsAt - Date.now())
    broadcastToRoom(code, { t: "game:prompt:tick", msLeft, x: p.submissions.size, y: r.players.length })
    if (msLeft <= 0) {
      if (p.tick) clearInterval(p.tick)
      p.tick = null
    }
  }, 500)
  phase.timeout = setTimeout(() => {
    endPromptPhase(code)
  }, PROMPT_DURATION_MS + 800)
}

function touchRoom(room: Room) {
  room.lastActivity = Date.now()
}

function getClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  const forwarded = c.req.header("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "127.0.0.1"
  const realIp = c.req.header("x-real-ip")
  if (realIp) return realIp
  const cfIp = c.req.header("cf-connecting-ip")
  if (cfIp) return cfIp
  return "127.0.0.1"
}

function checkRateLimit(ip: string): boolean {
  if (ip === "127.0.0.1") return true
  const now = Date.now()
  const windowStart = now - RATE_LIMIT_WINDOW_MS
  const hits = rateLimitByIp.get(ip) ?? []
  const filtered = hits.filter((t) => t > windowStart)
  if (filtered.length >= RATE_LIMIT_MAX) {
    rateLimitByIp.set(ip, filtered)
    return false
  }
  filtered.push(now)
  rateLimitByIp.set(ip, filtered)
  return true
}

const app = new Hono()

app.use(
  "*",
  cors({
    origin: (origin) => origin ?? undefined,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    credentials: true,
  })
)

app.get("/health", (c) => c.json({ ok: true, rooms: rooms.size }))

app.post("/api/rooms", async (c) => {
  const ip = getClientIp(c)
  if (!checkRateLimit(ip)) {
    return c.json({ error: "RATE_LIMITED", message: "Demasiadas salas creadas, intentá en un minuto" }, 429)
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "BAD_REQUEST", message: "JSON inválido" }, 400)
  }
  const parsed = PlayerInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: "VALIDATION", message: parsed.error.issues[0]?.message ?? "Datos inválidos" }, 400)
  }
  let code: string
  try {
    code = generateUniqueRoomCode()
  } catch {
    return c.json({ error: "ROOM_CODE_COLLISION", message: "No se pudo generar sala" }, 500)
  }
  const playerId = randomUUID()
  const token = randomUUID()
  const now = Date.now()
  const player: Player = {
    id: playerId,
    token,
    name: parsed.data.name.trim(),
    avatarColor: parsed.data.avatarColor,
    avatarText: parsed.data.avatarText.slice(0, 3),
    isHost: true,
    joinedAt: now,
  }
  const room: Room = {
    code,
    hostId: playerId,
    players: [player],
    state: "lobby",
    createdAt: now,
    lastActivity: now,
  }
  rooms.set(code, room)
  return c.json({ code, playerId, token, room: publicRoomPayload(room) }, 201)
})

app.post("/api/rooms/:code/join", async (c) => {
  const rawCode = c.req.param("code")?.toUpperCase() ?? ""
  if (!RoomCodeSchema.safeParse(rawCode).success) {
    return c.json({ error: "INVALID_CODE", message: "Código inválido" }, 400)
  }
  const code = rawCode
  const room = rooms.get(code)
  if (!room) {
    return c.json({ error: "NOT_FOUND", message: "Sala no encontrada" }, 404)
  }
  if (isExpired(room)) {
    rooms.delete(code)
    roomSockets.delete(code)
    clearCountdown(code)
    clearPrompt(code)
    clearMainPhase(code)
    return c.json({ error: "NOT_FOUND", message: "Sala expirada" }, 404)
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "BAD_REQUEST", message: "JSON inválido" }, 400)
  }
  const withToken = z
    .object({
      token: z.string().optional(),
      playerId: z.string().optional(),
      name: z.string().trim().min(1).max(20),
      avatarColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
      avatarText: z.string().trim().min(1).max(3),
    })
    .safeParse(body)
  if (!withToken.success) {
    return c.json({ error: "VALIDATION", message: withToken.error.issues[0]?.message ?? "Datos inválidos" }, 400)
  }
  const { token: incomingToken, playerId: incomingPlayerId, name, avatarColor, avatarText } = withToken.data

  if (incomingToken && incomingPlayerId) {
    const existing = room.players.find((p) => p.id === incomingPlayerId && p.token === incomingToken)
    if (existing) {
      touchRoom(room)
      return c.json({ code, playerId: existing.id, token: existing.token, room: publicRoomPayload(room), rejoined: true })
    }
  }

  if (room.state !== "lobby") {
    return c.json({ error: "ROOM_STARTED", message: "La partida ya comenzó" }, 409)
  }

  if (room.players.length >= MAX_PLAYERS) {
    return c.json({ error: "ROOM_FULL", message: "Sala llena (máx. 10)" }, 409)
  }

  const playerId = randomUUID()
  const token = randomUUID()
  const player: Player = {
    id: playerId,
    token,
    name: name.trim(),
    avatarColor,
    avatarText: avatarText.slice(0, 3),
    isHost: false,
    joinedAt: Date.now(),
  }
  room.players.push(player)
  touchRoom(room)
  broadcastRoomUpdate(code)
  return c.json({ code, playerId, token, room: publicRoomPayload(room) }, 201)
})

app.get("/api/rooms/:code", (c) => {
  const rawCode = c.req.param("code")?.toUpperCase() ?? ""
  if (!RoomCodeSchema.safeParse(rawCode).success) {
    return c.json({ error: "INVALID_CODE", message: "Código inválido" }, 400)
  }
  const room = rooms.get(rawCode)
  if (!room) return c.json({ error: "NOT_FOUND", message: "Sala no encontrada" }, 404)
  if (isExpired(room)) {
    rooms.delete(rawCode)
    roomSockets.delete(rawCode)
    clearCountdown(rawCode)
    clearPrompt(rawCode)
    clearMainPhase(rawCode)
    return c.json({ error: "NOT_FOUND", message: "Sala expirada" }, 404)
  }
  return c.json({ room: publicRoomPayload(room) })
})

app.post("/api/rooms/:code/leave", async (c) => {
  const rawCode = c.req.param("code")?.toUpperCase() ?? ""
  const room = rooms.get(rawCode)
  if (!room) return c.json({ error: "NOT_FOUND" }, 404)
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "BAD_REQUEST" }, 400)
  }
  const parsed = z.object({ playerId: z.string(), token: z.string() }).safeParse(body)
  if (!parsed.success) return c.json({ error: "VALIDATION" }, 400)
  const { playerId, token } = parsed.data
  const idx = room.players.findIndex((p) => p.id === playerId && p.token === token)
  if (idx === -1) return c.json({ error: "NOT_FOUND" }, 404)
  const wasHost = room.players[idx]?.isHost
  room.players.splice(idx, 1)
  const prompt = promptPhases.get(rawCode)
  if (prompt) {
    prompt.submissions.delete(playerId)
    prompt.assignments.delete(playerId)
  }
  if (room.players.length === 0) {
    rooms.delete(rawCode)
    roomSockets.delete(rawCode)
    clearCountdown(rawCode)
    clearPrompt(rawCode)
    clearMainPhase(rawCode)
    return c.json({ ok: true, destroyed: true })
  }
  if (wasHost) {
    room.players[0].isHost = true
    room.hostId = room.players[0].id
  }
  touchRoom(room)
  broadcastRoomUpdate(rawCode)
  if (prompt && room.state === "prompt") {
    broadcastPromptProgress(rawCode)
    if (prompt.submissions.size >= room.players.length) {
      endPromptPhase(rawCode)
    } else {
      broadcastToRoom(rawCode, { t: "game:prompt:tick", msLeft: Math.max(0, prompt.endsAt - Date.now()), x: prompt.submissions.size, y: room.players.length })
    }
  }
  if (prompt && room.state === "assigned" && prompt.assignments.size > 0) {
    const remaining = [...prompt.assignments.entries()].filter(([pid]) => room.players.some((p) => p.id === pid))
    if (remaining.length === 0) {
      clearPrompt(rawCode)
      clearMainPhase(rawCode)
      room.state = "lobby"
      broadcastRoomUpdate(rawCode)
    }
  }
  const clients = roomSockets.get(rawCode)
  if (clients) {
    for (const cl of [...clients]) {
      if (cl.playerId === playerId) {
        try {
          cl.ws.close(4000, "left")
        } catch {}
        clients.delete(cl)
      }
    }
  }
  return c.json({ ok: true, room: publicRoomPayload(room) })
})

const port = Number(process.env.PORT ?? 3001)

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`)
}) as unknown as import("node:http").Server

const wss = new WebSocketServer({ server, path: "/ws" })

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`)
  const code = (url.searchParams.get("code") ?? "").toUpperCase()
  const playerId = url.searchParams.get("playerId") ?? ""
  const token = url.searchParams.get("token") ?? ""

  if (!RoomCodeSchema.safeParse(code).success) {
    ws.send(JSON.stringify({ t: "error", code: "INVALID_CODE", message: "Código inválido" }))
    ws.close(1008, "invalid_code")
    return
  }
  const room = rooms.get(code)
  if (!room) {
    ws.send(JSON.stringify({ t: "error", code: "NOT_FOUND", message: "Sala no encontrada o expirada" }))
    ws.close(4000, "not_found")
    return
  }
  if (isExpired(room)) {
    rooms.delete(code)
    roomSockets.delete(code)
    clearCountdown(code)
    clearPrompt(code)
    clearMainPhase(code)
    ws.send(JSON.stringify({ t: "error", code: "NOT_FOUND", message: "Sala expirada" }))
    ws.close(4000, "expired")
    return
  }
  const player = room.players.find((p) => p.id === playerId && p.token === token)
  if (!player) {
    ws.send(JSON.stringify({ t: "error", code: "UNAUTHORIZED", message: "Jugador no autorizado" }))
    ws.close(1008, "unauthorized")
    return
  }

  const client: RoomClient = { ws, playerId, code }
  let set = roomSockets.get(code)
  if (!set) {
    set = new Set()
    roomSockets.set(code, set)
  }
  set.add(client)
  broadcastRoomUpdate(code)
  const existingPrompt = promptPhases.get(code)
  if (existingPrompt) {
    const msLeft = Math.max(0, existingPrompt.endsAt - Date.now())
    if (room.state === "prompt") {
      try {
        ws.send(JSON.stringify({ t: "game:prompt:start", durationMs: PROMPT_DURATION_MS, total: room.players.length, msLeft }))
        ws.send(JSON.stringify({ t: "game:prompt:progress", x: existingPrompt.submissions.size, y: room.players.length }))
        ws.send(JSON.stringify({ t: "game:prompt:tick", msLeft, x: existingPrompt.submissions.size, y: room.players.length }))
        if (existingPrompt.submissions.has(playerId)) {
          ws.send(JSON.stringify({ t: "game:prompt:submitted", x: existingPrompt.submissions.size, y: room.players.length }))
        }
      } catch {}
    } else if (room.state === "assigned" || room.state === "round" || room.state === "finished") {
      const assignedText = existingPrompt.assignments.get(playerId) ?? ""
      try {
        ws.send(JSON.stringify({ t: "game:prompt:result", assignedText }))
      } catch {}
    }
  }
  const existingMain = mainPhases.get(code)
  if (existingMain) {
    const msLeft = Math.max(0, existingMain.endsAt - Date.now())
    try {
      ws.send(JSON.stringify({ t: "game:main:start", durationMs: MAIN_DURATION_MS, msLeft }))
      ws.send(JSON.stringify({ t: "game:main:tick", msLeft, durationMs: MAIN_DURATION_MS }))
    } catch {}
  } else if (room.state === "finished") {
    try {
      ws.send(JSON.stringify({ t: "game:main:end" }))
    } catch {}
  }

  ws.on("message", (data) => {
    let msg: unknown
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    const type = (msg as { t?: string })?.t
    if (type === "ping") {
      try {
        ws.send(JSON.stringify({ t: "pong" }))
      } catch {}
      return
    }
    if (type === "keepalive") {
      broadcastRoomUpdate(code)
      return
    }
    if (type === "startCountdown" || type === "startGame" || type === "start") {
      if (player.id !== room.hostId) {
        try {
          ws.send(JSON.stringify({ t: "error", code: "NOT_HOST", message: "Solo el host puede iniciar" }))
        } catch {}
        return
      }
      if (room.players.length < 2) {
        try {
          ws.send(JSON.stringify({ t: "error", code: "NOT_ENOUGH_PLAYERS", message: "Se necesitan al menos 2 jugadores" }))
        } catch {}
        return
      }
      if (countdowns.has(code)) return
      if (promptPhases.has(code)) return
      if (mainPhases.has(code)) return
      if (room.state !== "lobby") return
      const seq: number[] = [3, 2, 1]
      const timers: NodeJS.Timeout[] = []
      countdowns.set(code, timers)
      seq.forEach((value, idx) => {
        const t = setTimeout(() => {
          broadcastToRoom(code, { t: "game:countdown", value })
          if (idx === seq.length - 1) {
            const end = setTimeout(() => {
              countdowns.delete(code)
            }, 1200)
            timers.push(end)
          }
        }, idx * 1000)
        timers.push(t)
      })
      const promptTimer = setTimeout(() => {
        startPromptPhase(code)
      }, 3000)
      timers.push(promptTimer)
      touchRoom(room)
      return
    }
    if (type === "prompt:submit" || type === "game:prompt:submit") {
      const phase = promptPhases.get(code)
      if (!phase || room.state !== "prompt") {
        try {
          ws.send(JSON.stringify({ t: "error", code: "NOT_IN_PROMPT", message: "No hay fase de escritura activa" }))
        } catch {}
        return
      }
      if (phase.assignments.size > 0) return
      const rawText = (msg as { text?: unknown }).text
      if (typeof rawText !== "string") {
        try {
          ws.send(JSON.stringify({ t: "error", code: "INVALID_TEXT", message: "Texto inválido" }))
        } catch {}
        return
      }
      const trimmed = rawText.trim().slice(0, PROMPT_MAX_LEN)
      if (trimmed.length < 1) {
        try {
          ws.send(JSON.stringify({ t: "error", code: "INVALID_TEXT", message: "Escribí algo para continuar" }))
        } catch {}
        return
      }
      if (trimmed.length > PROMPT_MAX_LEN) {
        try {
          ws.send(JSON.stringify({ t: "error", code: "INVALID_TEXT", message: `Máximo ${PROMPT_MAX_LEN} caracteres` }))
        } catch {}
        return
      }
      if (phase.submissions.has(playerId)) {
        try {
          ws.send(JSON.stringify({ t: "game:prompt:submitted", x: phase.submissions.size, y: room.players.length }))
        } catch {}
        return
      }
      phase.submissions.set(playerId, trimmed)
      touchRoom(room)
      broadcastPromptProgress(code)
      try {
        ws.send(JSON.stringify({ t: "game:prompt:submitted", x: phase.submissions.size, y: room.players.length }))
      } catch {}
      broadcastToRoom(code, { t: "game:prompt:tick", msLeft: Math.max(0, phase.endsAt - Date.now()), x: phase.submissions.size, y: room.players.length })
      if (phase.submissions.size >= room.players.length) {
        endPromptPhase(code)
      }
      return
    }
    if (type === "prompt:edit" || type === "game:prompt:edit" || type === "prompt:unsubmit" || type === "game:prompt:unsubmit") {
      const phase = promptPhases.get(code)
      if (!phase || room.state !== "prompt") return
      if (phase.assignments.size > 0) return
      if (!phase.submissions.has(playerId)) return
      const previous = phase.submissions.get(playerId) ?? ""
      phase.submissions.delete(playerId)
      touchRoom(room)
      broadcastPromptProgress(code)
      try {
        ws.send(JSON.stringify({ t: "game:prompt:edit_ok", x: phase.submissions.size, y: room.players.length, previousText: previous }))
      } catch {}
      broadcastToRoom(code, { t: "game:prompt:tick", msLeft: Math.max(0, phase.endsAt - Date.now()), x: phase.submissions.size, y: room.players.length })
      return
    }
    if (type === "leave") {
      const idx = room.players.findIndex((p) => p.id === playerId)
      if (idx !== -1) {
        const wasHost = room.players[idx]?.isHost
        room.players.splice(idx, 1)
        const prompt = promptPhases.get(code)
        if (prompt) {
          prompt.submissions.delete(playerId)
          prompt.assignments.delete(playerId)
        }
        if (room.players.length === 0) {
          broadcastRoomExpired(code, "empty")
          rooms.delete(code)
          roomSockets.delete(code)
          clearCountdown(code)
          clearPrompt(code)
          clearMainPhase(code)
          return
        }
        if (wasHost) {
          room.players[0].isHost = true
          room.hostId = room.players[0].id
        }
        touchRoom(room)
        broadcastRoomUpdate(code)
        if (prompt && room.state === "prompt") {
          broadcastPromptProgress(code)
          if (prompt.submissions.size >= room.players.length) {
            endPromptPhase(code)
          }
        }
      }
      ws.close(4000, "left")
      return
    }
  })

  ws.on("close", () => {
    set?.delete(client)
    if (set && set.size === 0) {
      roomSockets.delete(code)
    }
  })

  ws.on("error", () => {
    set?.delete(client)
  })

  ws.send(JSON.stringify({ t: "room:update", room: publicRoomPayload(room) }))
})

setInterval(() => {
  const now = Date.now()
  for (const [code, room] of rooms) {
    if (now - room.createdAt >= MAX_ROOM_LIFETIME_MS) {
      console.log(`[server] expiring room ${code} due to max lifetime 24h`)
      broadcastRoomExpired(code, "expired_24h")
      rooms.delete(code)
      roomSockets.delete(code)
      clearCountdown(code)
      clearPrompt(code)
      clearMainPhase(code)
    }
  }
}, MAX_ROOM_LIFETIME_CLEANUP_MS)

process.on("SIGTERM", () => {
  wss.close()
  server.close()
})
