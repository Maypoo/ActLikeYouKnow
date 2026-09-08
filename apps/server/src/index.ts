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
  state: "lobby" | "round" | "voting" | "reveal" | "podium"
  createdAt: number
  lastActivity: number
}

type RoomClient = {
  ws: WebSocket
  playerId: string
  code: string
}

const rooms = new Map<string, Room>()
const roomSockets = new Map<string, Set<RoomClient>>()
const rateLimitByIp = new Map<string, number[]>()
const countdowns = new Map<string, NodeJS.Timeout[]>()

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
  if (room.players.length === 0) {
    rooms.delete(rawCode)
    roomSockets.delete(rawCode)
    clearCountdown(rawCode)
    return c.json({ ok: true, destroyed: true })
  }
  if (wasHost) {
    room.players[0].isHost = true
    room.hostId = room.players[0].id
  }
  touchRoom(room)
  broadcastRoomUpdate(rawCode)
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
      touchRoom(room)
      return
    }
    if (type === "leave") {
      const idx = room.players.findIndex((p) => p.id === playerId)
      if (idx !== -1) {
        const wasHost = room.players[idx]?.isHost
        room.players.splice(idx, 1)
        if (room.players.length === 0) {
          broadcastRoomExpired(code, "empty")
          rooms.delete(code)
          roomSockets.delete(code)
          clearCountdown(code)
          return
        }
        if (wasHost) {
          room.players[0].isHost = true
          room.hostId = room.players[0].id
        }
        touchRoom(room)
        broadcastRoomUpdate(code)
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
    }
  }
}, MAX_ROOM_LIFETIME_CLEANUP_MS)

process.on("SIGTERM", () => {
  wss.close()
  server.close()
})
