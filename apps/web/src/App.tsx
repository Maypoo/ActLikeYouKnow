import { useCallback, useEffect, useRef, useState } from "react"
import { Check, X, Plus } from "lucide-react"
import AudioRecorder from "./components/AudioRecorder"

type ModalMode = "create" | "join" | null

type RoomPlayer = {
  id: string
  name: string
  avatarColor: string
  avatarText: string
  isHost: boolean
  joinedAt: number
}

type RoomData = {
  code: string
  hostId: string
  players: RoomPlayer[]
  state: string
  createdAt: number
  lastActivity: number
}

type ScriptLine = {
  characterId: string
  text: string
  order: number
}

type ScriptView = {
  scriptId: string
  scriptTitle: string
  character: { id: string }
  lines: ScriptLine[]
  totalLines: number
  act?: number
  totalActs?: number
}

const STORAGE_KEY = "actlike_player_name"
const STORAGE_COLOR_KEY = "actlike_player_color"
const STORAGE_TEXT_KEY = "actlike_avatar_text"
const STORAGE_ROOM_CODE = "actlike_room_code"
const STORAGE_PLAYER_ID = "actlike_player_id"
const STORAGE_TOKEN = "actlike_player_token"

const AVATAR_COLORS = [
  "#7C5CFF",
  "#AF52DE",
  "#FF4D6A",
  "#FF8C42",
  "#FFB830",
  "#FFE600",
  "#00E5CC",
  "#00B8A9",
  "#34D399",
  "#38BDF8",
  "#818CF8",
  "#FB7185",
] as const

const DEFAULT_COLOR = AVATAR_COLORS[0]

function getWsUrl(code: string, playerId: string, token: string) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
  const isDevVite = window.location.port === "5173"
  const host = isDevVite ? `${window.location.hostname}:3001` : window.location.host
  return `${proto}//${host}/ws?code=${encodeURIComponent(code)}&playerId=${encodeURIComponent(playerId)}&token=${encodeURIComponent(token)}`
}

function App() {
  const [mode, setMode] = useState<ModalMode>(null)
  const [name, setName] = useState("")
  const [roomCode, setRoomCode] = useState("")
  const [avatarColor, setAvatarColor] = useState<string>(DEFAULT_COLOR)
  const [avatarText, setAvatarText] = useState("¿?")
  const [pickerOpen, setPickerOpen] = useState(false)
  const [nameError, setNameError] = useState("")
  const [codeError, setCodeError] = useState("")
  const [submitError, setSubmitError] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [currentRoom, setCurrentRoom] = useState<RoomData | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [expiredMessage, setExpiredMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [countdown, setCountdown] = useState<string | number | null>(null)
  const [promptActive, setPromptActive] = useState(false)
  const [promptMsLeft, setPromptMsLeft] = useState<number>(60000)
  const [promptProgress, setPromptProgress] = useState<{ x: number; y: number } | null>(null)
  const [promptInput, setPromptInput] = useState("")
  const [promptSubmitted, setPromptSubmitted] = useState(false)
  const [promptError, setPromptError] = useState("")
  const [assignedText, setAssignedText] = useState<string | null>(null)
  const [assignedTextDismissed, setAssignedTextDismissed] = useState(false)
  const [scriptView, setScriptView] = useState<ScriptView | null>(null)
  const [actingIndex, setActingIndex] = useState(0)
  const [scriptConfirmed, setScriptConfirmed] = useState(false)
  const [scriptConfirmProgress, setScriptConfirmProgress] = useState<{ x: number; y: number } | null>(null)
  const [mainMsLeft, setMainMsLeft] = useState<number>(180000)
  const [mainActive, setMainActive] = useState(false)
  const [mainFinished, setMainFinished] = useState(false)
  const countdownTimeoutRef = useRef<number | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const codeInputRef = useRef<HTMLInputElement>(null)
  const promptInputRef = useRef<HTMLInputElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const heartbeatRef = useRef<number | null>(null)
  const expiredMessageRef = useRef<string | null>(null)
  const shouldReconnectRef = useRef(true)

  const isCreate = mode === "create"
  const isJoin = mode === "join"
  const isOpen = mode !== null

  useEffect(() => {
    const storedCode = localStorage.getItem(STORAGE_ROOM_CODE)
    const storedPlayerId = localStorage.getItem(STORAGE_PLAYER_ID)
    const storedToken = localStorage.getItem(STORAGE_TOKEN)
    if (storedCode && storedPlayerId && storedToken) {
      fetch(`/api/rooms/${storedCode}`)
        .then((r) => {
          if (!r.ok) throw new Error("not_found")
          return r.json()
        })
        .then((data) => {
          const room = data.room as RoomData
          const exists = room.players.some((p) => p.id === storedPlayerId)
          if (!exists) throw new Error("not_in_room")
          setCurrentRoom(room)
          setPlayerId(storedPlayerId)
          setToken(storedToken)
        })
        .catch(() => {
          localStorage.removeItem(STORAGE_ROOM_CODE)
          localStorage.removeItem(STORAGE_PLAYER_ID)
          localStorage.removeItem(STORAGE_TOKEN)
        })
    }
    const pathMatch = window.location.pathname.match(/\/j\/([A-Z0-9]{6})/i)
    const searchCode = new URLSearchParams(window.location.search).get("code")
    const deepCode = pathMatch?.[1]?.toUpperCase() ?? searchCode?.toUpperCase() ?? ""
    if (deepCode && /^[A-Z0-9]{6}$/.test(deepCode) && !storedCode) {
      setRoomCode(deepCode)
      setMode("join")
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) setName(stored)
    const storedColor = localStorage.getItem(STORAGE_COLOR_KEY)
    if (storedColor && (AVATAR_COLORS as readonly string[]).includes(storedColor)) {
      setAvatarColor(storedColor)
    } else if (storedColor && /^#[0-9A-Fa-f]{6}$/.test(storedColor)) {
      setAvatarColor(storedColor)
    }
    const storedText = localStorage.getItem(STORAGE_TEXT_KEY)
    if (storedText !== null) setAvatarText(storedText.slice(0, 3) || "¿?")
    setPickerOpen(false)
    setSubmitError("")
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (pickerOpen) setPickerOpen(false)
        else setMode(null)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [isOpen, pickerOpen])

  useEffect(() => {
    expiredMessageRef.current = expiredMessage
  }, [expiredMessage])

  const clearSession = useCallback(() => {
    shouldReconnectRef.current = false
    localStorage.removeItem(STORAGE_ROOM_CODE)
    localStorage.removeItem(STORAGE_PLAYER_ID)
    localStorage.removeItem(STORAGE_TOKEN)
    setCurrentRoom(null)
    setPlayerId(null)
    setToken(null)
    setWsConnected(false)
    setCountdown(null)
    setPromptActive(false)
    setPromptMsLeft(60000)
    setPromptProgress(null)
    setPromptInput("")
    setPromptSubmitted(false)
    setPromptError("")
    setAssignedText(null)
    setAssignedTextDismissed(false)
    setScriptView(null)
    setActingIndex(0)
    setScriptConfirmed(false)
    setScriptConfirmProgress(null)
    setMainMsLeft(180000)
    setMainActive(false)
    setMainFinished(false)
    if (countdownTimeoutRef.current) {
      window.clearTimeout(countdownTimeoutRef.current)
      countdownTimeoutRef.current = null
    }
    if (wsRef.current) {
      try {
        wsRef.current.close(4000, "leave")
      } catch {}
      wsRef.current = null
    }
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (heartbeatRef.current) {
      window.clearInterval(heartbeatRef.current)
      heartbeatRef.current = null
    }
    reconnectAttemptsRef.current = 0
    window.history.replaceState({}, "", "/")
    window.setTimeout(() => {
      shouldReconnectRef.current = true
    }, 500)
  }, [])

  const connectWs = useCallback(
    (code: string, pid: string, tk: string) => {
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        try {
          wsRef.current.close(4000, "reconnect")
        } catch {}
        wsRef.current = null
      }
      if (heartbeatRef.current) {
        window.clearInterval(heartbeatRef.current)
        heartbeatRef.current = null
      }
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      shouldReconnectRef.current = true
      const ws = new WebSocket(getWsUrl(code, pid, tk))
      wsRef.current = ws

      ws.addEventListener("open", () => {
        reconnectAttemptsRef.current = 0
        setWsConnected(true)
        setExpiredMessage(null)
        expiredMessageRef.current = null
        heartbeatRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ t: "ping" }))
            } catch {}
          }
        }, 25000)
      })

      ws.addEventListener("message", (ev) => {
        let data: unknown
        try {
          data = JSON.parse(ev.data as string)
        } catch {
          return
        }
        const msg = data as {
          t?: string
          room?: RoomData
          reason?: string
          code?: string
          message?: string
          value?: string | number
          assignedText?: string
          durationMs?: number
          msLeft?: number
          x?: number
          y?: number
          total?: number
          previousText?: string
          view?: ScriptView
        }
        if (msg.t === "room:update" && msg.room) {
          setCurrentRoom(msg.room)
          if (msg.room.state === "lobby") {
            setPromptActive(false)
            setPromptSubmitted(false)
            setAssignedText(null)
            setAssignedTextDismissed(false)
            setScriptView(null)
            setActingIndex(0)
            setScriptConfirmed(false)
            setScriptConfirmProgress(null)
            setMainActive(false)
            setMainFinished(false)
            setMainMsLeft(180000)
          } else {
            if (countdownTimeoutRef.current) {
              window.clearTimeout(countdownTimeoutRef.current)
              countdownTimeoutRef.current = null
            }
            setCountdown(null)
            if (msg.room.state === "round") {
              setMainActive(true)
              setMainFinished(false)
            } else if (msg.room.state === "finished") {
              setMainActive(false)
              setMainFinished(true)
            }
          }
        }
        if (msg.t === "pong") return
        if (msg.t === "game:countdown:done") {
          if (countdownTimeoutRef.current) {
            window.clearTimeout(countdownTimeoutRef.current)
            countdownTimeoutRef.current = null
          }
          setCountdown(null)
          return
        }
        if (msg.t === "game:countdown" && msg.value !== undefined) {
          if (countdownTimeoutRef.current) {
            window.clearTimeout(countdownTimeoutRef.current)
            countdownTimeoutRef.current = null
          }
          setCountdown(msg.value)
          if (msg.value === 1) {
            countdownTimeoutRef.current = window.setTimeout(() => setCountdown(null), 950)
          }
          return
        }
        if (msg.t === "game:prompt:start") {
          if (countdownTimeoutRef.current) {
            window.clearTimeout(countdownTimeoutRef.current)
            countdownTimeoutRef.current = null
          }
          setCountdown(null)
          setPromptActive(true)
          setPromptSubmitted(false)
          setPromptInput("")
          setPromptError("")
          setAssignedText(null)
          setAssignedTextDismissed(false)
          const dur = typeof msg.durationMs === "number" ? msg.durationMs : 60000
          const left = typeof msg.msLeft === "number" ? msg.msLeft : dur
          setPromptMsLeft(left)
          const total = typeof msg.total === "number" ? msg.total : (typeof msg.y === "number" ? msg.y : 0)
          if (typeof msg.x === "number" && typeof msg.y === "number") {
            setPromptProgress({ x: msg.x, y: msg.y })
          } else {
            setPromptProgress({ x: 0, y: total })
          }
          requestAnimationFrame(() => promptInputRef.current?.focus())
          return
        }
        if (msg.t === "game:prompt:tick" && typeof msg.msLeft === "number") {
          setPromptMsLeft(msg.msLeft)
          if (typeof msg.x === "number" && typeof msg.y === "number") {
            setPromptProgress({ x: msg.x, y: msg.y })
          }
          return
        }
        if (msg.t === "game:prompt:progress" && typeof msg.x === "number" && typeof msg.y === "number") {
          setPromptProgress({ x: msg.x, y: msg.y })
          return
        }
        if (msg.t === "game:prompt:submitted") {
          setPromptSubmitted(true)
          setPromptError("")
          if (typeof msg.x === "number" && typeof msg.y === "number") {
            setPromptProgress({ x: msg.x, y: msg.y })
          }
          return
        }
        if (msg.t === "game:prompt:edit_ok") {
          setPromptSubmitted(false)
          setPromptError("")
          if (typeof msg.previousText === "string") setPromptInput(msg.previousText)
          if (typeof msg.x === "number" && typeof msg.y === "number") {
            setPromptProgress({ x: msg.x, y: msg.y })
          }
          requestAnimationFrame(() => promptInputRef.current?.focus())
          return
        }
        if (msg.t === "game:prompt:result" && typeof msg.assignedText === "string") {
          setPromptActive(false)
          setPromptSubmitted(true)
          setAssignedText(msg.assignedText)
          setAssignedTextDismissed(false)
          return
        }
        if (msg.t === "game:prompt:done") {
          setPromptActive(false)
          return
        }
        if (msg.t === "game:main:start") {
          setMainActive(true)
          setMainFinished(false)
          const dur = typeof msg.durationMs === "number" ? msg.durationMs : 180000
          const left = typeof msg.msLeft === "number" ? msg.msLeft : dur
          setMainMsLeft(left)
          return
        }
        if (msg.t === "game:main:tick" && typeof msg.msLeft === "number") {
          setMainMsLeft(msg.msLeft)
          return
        }
        if (msg.t === "game:main:end") {
          setMainActive(false)
          setMainFinished(true)
          setMainMsLeft(0)
          return
        }
        if (msg.t === "game:script:assigned" && msg.view) {
          const v = msg.view as ScriptView
          if (v && typeof v.scriptId === "string" && Array.isArray(v.lines)) {
            const sorted = [...v.lines].sort((a, b) => a.order - b.order)
            setScriptView({ ...v, lines: sorted })
            setActingIndex(0)
            setScriptConfirmed(false)
            setScriptConfirmProgress(null)
          }
          return
        }
        if (msg.t === "game:script:confirm:progress" && typeof msg.x === "number" && typeof msg.y === "number") {
          setScriptConfirmProgress({ x: msg.x, y: msg.y })
          return
        }
        if (msg.t === "game:script:confirmed") {
          setScriptConfirmed(true)
          return
        }
        if (msg.t === "room:expired") {
          shouldReconnectRef.current = false
          setExpiredMessage("La sala expiró (24h).")
          window.setTimeout(() => {
            clearSession()
            setExpiredMessage(null)
            expiredMessageRef.current = null
          }, 2500)
        }
        if (msg.t === "error") {
          const m = msg.message ?? msg.code ?? "Error"
          if (m === "NOT_FOUND" || msg.code === "NOT_FOUND") {
            shouldReconnectRef.current = false
            setExpiredMessage("La sala ya no existe o expiró.")
            window.setTimeout(() => {
              clearSession()
              setExpiredMessage(null)
              expiredMessageRef.current = null
            }, 2500)
          }
        }
      })

      ws.addEventListener("close", (ev) => {
        setWsConnected(false)
        if (heartbeatRef.current) {
          window.clearInterval(heartbeatRef.current)
          heartbeatRef.current = null
        }
        if (ev.code === 4000) return
        if (!shouldReconnectRef.current) return
        if (expiredMessageRef.current) return
        if (!localStorage.getItem(STORAGE_ROOM_CODE)) return
        const attempts = reconnectAttemptsRef.current
        if (attempts >= 10) return
        const delay = Math.min(800 * Math.pow(1.5, attempts), 5000)
        reconnectAttemptsRef.current = attempts + 1
        reconnectTimerRef.current = window.setTimeout(() => {
          const c = localStorage.getItem(STORAGE_ROOM_CODE)
          const p = localStorage.getItem(STORAGE_PLAYER_ID)
          const tk2 = localStorage.getItem(STORAGE_TOKEN)
          if (c && p && tk2 && shouldReconnectRef.current) connectWs(c, p, tk2)
        }, delay)
      })

      ws.addEventListener("error", () => {
        setWsConnected(false)
      })
    },
    [clearSession]
  )

  useEffect(() => {
    if (!promptActive || promptSubmitted) return
    if (promptMsLeft > 1500) return
    const trimmed = promptInput.trim()
    if (trimmed.length < 1) return
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    try {
      wsRef.current.send(JSON.stringify({ t: "prompt:submit", text: trimmed }))
    } catch {}
  }, [promptMsLeft, promptActive, promptSubmitted, promptInput])

  useEffect(() => {
    if (!currentRoom || !playerId || !token) return
    connectWs(currentRoom.code, playerId, token)
    return () => {
      if (wsRef.current) {
        try {
          wsRef.current.close()
        } catch {}
        wsRef.current = null
      }
      if (heartbeatRef.current) {
        window.clearInterval(heartbeatRef.current)
        heartbeatRef.current = null
      }
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }
  }, [currentRoom?.code, playerId, token, connectWs])

  function close() {
    setMode(null)
    setPickerOpen(false)
    setNameError("")
    setCodeError("")
    setSubmitError("")
    if (!currentRoom) setRoomCode("")
  }

  function validate() {
    const trimmedName = name.trim()
    let valid = true
    if (trimmedName.length < 1) {
      setNameError("Elegí un nombre para continuar")
      valid = false
    } else if (trimmedName.length > 20) {
      setNameError("Máximo 20 caracteres")
      valid = false
    } else {
      setNameError("")
    }
    if (isJoin) {
      const normalized = roomCode.trim().toUpperCase()
      if (!/^[A-Z0-9]{6}$/.test(normalized)) {
        setCodeError("Código de 6 letras/números")
        valid = false
      } else {
        setCodeError("")
      }
    }
    return valid
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) {
      if (name.trim().length === 0) nameInputRef.current?.focus()
      else if (isJoin && !/^[A-Z0-9]{6}$/.test(roomCode.trim().toUpperCase())) codeInputRef.current?.focus()
      return
    }
    const trimmedName = name.trim()
    localStorage.setItem(STORAGE_KEY, trimmedName)
    localStorage.setItem(STORAGE_COLOR_KEY, avatarColor)
    localStorage.setItem(STORAGE_TEXT_KEY, avatarText.slice(0, 3))
    setIsSubmitting(true)
    setSubmitError("")
    try {
      if (isCreate) {
        const res = await fetch("/api/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmedName, avatarColor, avatarText: avatarText.slice(0, 3) || "¿?" }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.message ?? data.error ?? "No se pudo crear la sala")
        const code = data.code as string
        const pid = data.playerId as string
        const tk = data.token as string
        const room = data.room as RoomData
        localStorage.setItem(STORAGE_ROOM_CODE, code)
        localStorage.setItem(STORAGE_PLAYER_ID, pid)
        localStorage.setItem(STORAGE_TOKEN, tk)
        setCurrentRoom(room)
        setPlayerId(pid)
        setToken(tk)
        setMode(null)
        setPickerOpen(false)
        window.history.replaceState({}, "", `/j/${code}`)
      } else {
        const normalized = roomCode.trim().toUpperCase()
        const res = await fetch(`/api/rooms/${normalized}/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmedName, avatarColor, avatarText: avatarText.slice(0, 3) || "¿?" }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.message ?? data.error ?? "No se pudo unir a la sala")
        const code = data.code as string
        const pid = data.playerId as string
        const tk = data.token as string
        const room = data.room as RoomData
        localStorage.setItem(STORAGE_ROOM_CODE, code)
        localStorage.setItem(STORAGE_PLAYER_ID, pid)
        localStorage.setItem(STORAGE_TOKEN, tk)
        setCurrentRoom(room)
        setPlayerId(pid)
        setToken(tk)
        setMode(null)
        setPickerOpen(false)
        window.history.replaceState({}, "", `/j/${code}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error inesperado"
      if (msg.includes("NOT_FOUND") || msg.includes("no encontrada")) setSubmitError("Sala no encontrada. Verificá el código.")
      else if (msg.includes("ROOM_FULL") || msg.includes("llena")) setSubmitError("Sala llena (máx. 10 jugadores).")
      else if (msg.includes("RATE_LIMITED")) setSubmitError("Demasiadas salas creadas, esperá un minuto.")
      else setSubmitError(msg)
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleLeave() {
    const code = currentRoom?.code
    const pid = playerId
    const tk = token
    if (code && pid && tk) {
      try {
        await fetch(`/api/rooms/${code}/leave`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playerId: pid, token: tk }),
        })
      } catch {}
      if (wsRef.current) {
        try {
          wsRef.current.send(JSON.stringify({ t: "leave" }))
        } catch {}
      }
    }
    clearSession()
  }

  async function handleCopy() {
    const code = currentRoom?.code
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
      if (navigator.vibrate) navigator.vibrate(10)
    } catch {
      const el = document.createElement("textarea")
      el.value = code
      document.body.appendChild(el)
      el.select()
      document.execCommand("copy")
      document.body.removeChild(el)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    }
  }

  function handleStartGame() {
    if (!isHost || !canStart) return
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    try {
      wsRef.current.send(JSON.stringify({ t: "startCountdown" }))
    } catch {}
  }

  function handlePromptSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = promptInput.trim()
    if (trimmed.length < 1) {
      setPromptError("Escribí algo para continuar")
      return
    }
    if (trimmed.length > 80) {
      setPromptError("Máximo 80 caracteres")
      return
    }
    if (promptSubmitted) return
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setPromptError("Sin conexión, reintentá")
      return
    }
    setPromptError("")
    try {
      wsRef.current.send(JSON.stringify({ t: "prompt:submit", text: trimmed }))
    } catch {
      setPromptError("No se pudo enviar")
    }
  }

  function handlePromptEdit() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setPromptError("Sin conexión, reintentá")
      return
    }
    setPromptError("")
    try {
      wsRef.current.send(JSON.stringify({ t: "prompt:edit" }))
    } catch {
      setPromptError("No se pudo editar")
    }
  }

  function selectColor(color: string) {
    setAvatarColor(color)
  }

  function handleActingNext() {
    if (!scriptView) return
    if (actingIndex < scriptView.lines.length - 1) {
      setActingIndex((v) => v + 1)
    }
  }

  function handleScriptConfirm() {
    if (!scriptView || scriptConfirmed) return
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    try {
      wsRef.current.send(JSON.stringify({ t: "game:script:confirm" }))
      setScriptConfirmed(true)
    } catch {}
  }

  function formatMainTime(ms: number) {
    const total = Math.max(0, Math.ceil(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  }

  const hostNameRaw = currentRoom ? (currentRoom.players.find((p) => p.id === currentRoom.hostId)?.name ?? currentRoom.players.find((p) => p.isHost)?.name ?? currentRoom.players[0]?.name ?? "") : ""
  const hostName = hostNameRaw.toUpperCase()
  const isHost = !!currentRoom && !!playerId && currentRoom.hostId === playerId
  const canStart = !!currentRoom && currentRoom.players.length > 1

  const showGame = !!currentRoom && !!playerId && (promptActive || assignedText !== null || scriptView !== null || mainActive || mainFinished || currentRoom.state === "prompt" || currentRoom.state === "assigned" || currentRoom.state === "round" || currentRoom.state === "finished")

  if (currentRoom && playerId) {
    if (showGame) {
      return (
        <main className="game-layout">
          <div className="landing-rays" aria-hidden="true" />
          {mainActive && !mainFinished && !promptActive && (
            <div className="game-topbar" aria-live="polite" aria-atomic="true">
              {scriptConfirmProgress && (
                <div className="script-confirm-progress">
                  {scriptConfirmProgress.x}/{scriptConfirmProgress.y}
                </div>
              )}
              <div className="main-timer-fixed">{formatMainTime(mainMsLeft)}</div>
            </div>
          )}
          <div className="game-stage" aria-live="polite" aria-atomic="true">
            {promptActive ? (
              <form className="prompt-card" onSubmit={handlePromptSubmit}>
                <div className="prompt-top">
                  <span className="prompt-timer">{Math.ceil(promptMsLeft / 1000)}s</span>
                  {promptProgress && (
                    <span className="prompt-progress">
                      {promptProgress.x}/{promptProgress.y}
                    </span>
                  )}
                </div>
                <h2 className="prompt-title">Forma de hablar/actuar</h2>
                <input
                  ref={promptInputRef}
                  className={`prompt-input ${promptError ? "prompt-input--error" : ""}`}
                  type="text"
                  value={promptInput}
                  onChange={(e) => setPromptInput(e.target.value.slice(0, 80))}
                  placeholder="Ej: Como argentino"
                  maxLength={80}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  disabled={promptSubmitted}
                />
                {promptError ? <span className="prompt-error">{promptError}</span> : null}
                {promptSubmitted ? (
                  <button type="button" className="btn btn-secondary prompt-submit" onClick={handlePromptEdit}>
                    Editar
                  </button>
                ) : (
                  <button type="submit" className="btn btn-primary prompt-submit">
                    Confirmar
                  </button>
                )}
              </form>
            ) : mainFinished ? (
              <div className="prompt-card prompt-card--result">
                <span className="prompt-result-value">La partida termino</span>
                <button type="button" className="btn btn-primary prompt-result-close" onClick={handleLeave}>
                  Salir
                </button>
              </div>
            ) : assignedText !== null && !assignedTextDismissed ? (
              <div className="prompt-card prompt-card--result">
                <span className="prompt-result-label">Te tocó actuar como</span>
                <span className="prompt-result-value">{assignedText || "—"}</span>
                <button type="button" className="btn btn-primary prompt-result-close" onClick={() => setAssignedTextDismissed(true)}>
                  Entendido
                </button>
              </div>
            ) : scriptView ? (
              (() => {
                const currentLine = scriptView.lines[Math.min(actingIndex, scriptView.lines.length - 1)]!
                const isLast = actingIndex >= scriptView.lines.length - 1
                return (
                  <div className="acting-card">
                    <div className="acting-header">
                      <span className="acting-label">A ACTUAR</span>
                      {scriptView.totalActs === 2 && scriptView.act ? (
                        <span className="acting-act-badge">Acto {scriptView.act} de 2</span>
                      ) : null}
                      <span className="acting-character">Forma de hablar: {assignedText || "—"}</span>
                    </div>
                    <div className="acting-lines">
                      <div key={currentLine.order} className="acting-line">
                        <p className="acting-line-text">{currentLine.text}</p>
                      </div>
                    </div>
                    <AudioRecorder key={scriptView.scriptId + "-" + currentLine.order} lineKey={scriptView.scriptId + "-" + currentLine.order} />
                    <span className="acting-step">{actingIndex + 1} / {scriptView.lines.length}</span>
                    {!scriptConfirmed ? (
                      isLast ? (
                        <button type="button" className="btn btn-primary acting-next" onClick={handleScriptConfirm}>
                          Confirmar
                        </button>
                      ) : (
                        <button type="button" className="btn btn-primary acting-next" onClick={handleActingNext}>
                          Siguiente
                        </button>
                      )
                    ) : (
                      <>
                        <button type="button" className="btn btn-primary acting-next" disabled aria-disabled="true">
                          Confirmado <Check size={16} />
                        </button>
                        <p className="game-waiting-hint">Esperando al resto… {scriptConfirmProgress ? `${scriptConfirmProgress.x}/${scriptConfirmProgress.y}` : ""}</p>
                      </>
                    )}
                    {!scriptConfirmed && <p className="game-waiting-hint">Solo vos ves esta línea. ¡Actuá en orden!</p>}
                  </div>
                )
              })()
            ) : mainActive ? (
              <div className="prompt-card prompt-card--result">
                <span className="prompt-result-label">A actuar</span>
                <p className="game-waiting-hint">Tenés 3 minutos para actuar</p>
              </div>
            ) : (
              <div className="prompt-card prompt-card--result">
                <span className="prompt-result-label">¡Listo!</span>
                <span className="prompt-result-value">Guardá tu papel en secreto</span>
                <p className="game-waiting-hint">Esperando al resto de jugadores…</p>
                <button type="button" className="btn btn-ghost prompt-result-close" onClick={handleLeave}>
                  Salir
                </button>
              </div>
            )}
          </div>
          {countdown !== null && (
            <div className="countdown-overlay" aria-live="assertive" aria-atomic="true">
              <div key={String(countdown)} className="countdown-wrap">
                <span className="countdown-value">{countdown}</span>
              </div>
            </div>
          )}
        </main>
      )
    }

    return (
      <main className="room-layout">
        <div className="landing-rays" aria-hidden="true" />
        <div className="room-card">
          <div className="room-header">
            <div className="room-title-block">
              <h1 className="room-title">SALA DE {hostName}</h1>
            </div>
          </div>

          <div className="room-code-block">
            <div className="room-code-label">CÓDIGO DE INVITACIÓN</div>
            <div className="room-code-row">
              <span className="room-code-value">{currentRoom.code}</span>
              <button type="button" className={`btn btn-copy ${copied ? "btn-copy--done" : ""}`} onClick={handleCopy} aria-label="Copiar código">
                {copied ? "¡Copiado!" : "Copiar"}
              </button>
            </div>
          </div>

          {expiredMessage && <div className="room-expired">{expiredMessage}</div>}

          <div className="room-players-header">
            <span className="room-players-title">Jugadores</span>
            <span className="room-players-count">
              {currentRoom.players.length}/10
            </span>
          </div>

          <div className="room-grid">
            {currentRoom.players.map((p) => {
              const isMe = p.id === playerId
              return (
                <div key={p.id} className={`player-card ${isMe ? "player-card--me" : ""} ${p.isHost ? "player-card--host" : ""}`}>
                  <div className="player-avatar" style={{ background: p.avatarColor }}>
                    <span className="player-avatar-text">{p.avatarText}</span>
                  </div>
                  <div className="player-info">
                    <span className="player-name">
                      {p.name}
                      {isMe ? " (vos)" : ""}
                    </span>
                    {p.isHost && <span className="player-badge">HOST</span>}
                  </div>
                  <span className={`player-ring ${wsConnected ? "player-ring--on" : ""}`} aria-hidden="true" />
                </div>
              )
            })}
            {Array.from({ length: Math.max(0, 2 - currentRoom.players.length) }).map((_, i) => (
              <div key={`empty-${i}`} className="player-card player-card--empty">
                <div className="player-avatar player-avatar--empty"><Plus size={20} /></div>
                <span className="player-empty-label">Esperando jugador…</span>
              </div>
            ))}
          </div>

          <div className="room-actions">
            {isHost && (
              <button type="button" className="btn btn-primary btn-start" disabled={!canStart} aria-disabled={!canStart} onClick={handleStartGame}>
                Iniciar partida
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-leave" onClick={handleLeave}>
              Salir
            </button>
          </div>

          <div className="room-footer">
            <p className="room-footer-hint">Compartí el código con tus amigos. Cuando se unan aparecerán acá en tiempo real.</p>
          </div>
        </div>
        {countdown !== null && (
          <div className="countdown-overlay" aria-live="assertive" aria-atomic="true">
            <div key={String(countdown)} className="countdown-wrap">
              <span className="countdown-value">{countdown}</span>
            </div>
          </div>
        )}
      </main>
    )
  }

  return (
    <main className="landing">
      <div className="landing-rays" aria-hidden="true" />
      <div className="landing-card">
        <h1 className="landing-title">
          <span className="title-line">ACT LIKE</span>
          <span className="title-line title-accent">YOU KNOW</span>
        </h1>
        <div className="landing-actions" role="group" aria-label="Acciones de sala">
          <button type="button" className="btn btn-primary" onClick={() => setMode("create")}>
            Crear sala
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setMode("join")}>
            Unirse a una sala
          </button>
        </div>
        <p className="landing-subtitle">Te damos una escena, te damos una voz. El resto depende de vos.</p>
        {expiredMessage && <div className="landing-expired">{expiredMessage}</div>}
      </div>

      {isOpen && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="modal-close" onClick={close} aria-label="Cerrar">
              <X size={18} />
            </button>
            <h2 id="modal-title" className="modal-title">
              {isCreate ? "¿Cómo te llamas?" : "Unite a la partida"}
            </h2>
            <p className="modal-desc">
              {isCreate ? "Elegí el nombre que verán los demás jugadores." : "Ingresá tu nombre y el código de la sala."}
            </p>

            <div className="avatar-block">
              <label className="avatar-circle" style={{ background: avatarColor }} aria-label="Texto del avatar">
                <input
                  className="avatar-text-input"
                  type="text"
                  value={avatarText}
                  onChange={(e) => setAvatarText(e.target.value.slice(0, 3))}
                  maxLength={3}
                  aria-label="Texto del avatar"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <button type="button" className="avatar-edit" onClick={() => setPickerOpen((v) => !v)} aria-expanded={pickerOpen} aria-controls="avatar-palette">
                {pickerOpen ? "Cerrar" : "Editar"}
              </button>
              {pickerOpen && (
                <div id="avatar-palette" className="avatar-palette" role="group" aria-label="Paleta de colores">
                  {AVATAR_COLORS.map((color) => {
                    const selected = color === avatarColor
                    return (
                      <button
                        key={color}
                        type="button"
                        className={`palette-swatch ${selected ? "palette-swatch--selected" : ""}`}
                        style={{ background: color }}
                        onClick={() => selectColor(color)}
                        aria-label={`Color ${color}`}
                        aria-pressed={selected}
                      >
                        {selected && <span className="palette-check" aria-hidden="true"><Check size={14} color="white" /></span>}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <form className="modal-form" onSubmit={handleSubmit} noValidate>
              <label className="field">
                <span className="field-label">Tu nombre</span>
                <input
                  ref={nameInputRef}
                  className={`field-input ${nameError ? "field-input--error" : ""}`}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ej. Mauro"
                  maxLength={20}
                  autoComplete="nickname"
                  spellCheck={false}
                />
                {nameError ? <span className="field-error">{nameError}</span> : null}
              </label>

              {isJoin && (
                <label className="field">
                  <span className="field-label">Código de sala</span>
                  <input
                    ref={codeInputRef}
                    className={`field-input field-input--code ${codeError ? "field-input--error" : ""}`}
                    type="text"
                    value={roomCode}
                    onChange={(e) => setRoomCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
                    placeholder="XK7PQ8"
                    maxLength={6}
                    autoComplete="off"
                    spellCheck={false}
                    inputMode="text"
                  />
                  {codeError ? <span className="field-error">{codeError}</span> : null}
                </label>
              )}

              {submitError ? <span className="field-error field-error--submit">{submitError}</span> : null}

              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={close} disabled={isSubmitting}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary btn-modal" disabled={isSubmitting}>
                  {isSubmitting ? "Entrando…" : isCreate ? "Crear sala" : "Unirse"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
