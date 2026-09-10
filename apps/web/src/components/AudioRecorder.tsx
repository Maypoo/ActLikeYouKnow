import { useEffect, useRef, useState } from "react"
import { Mic, Square, Play, Pause, RotateCcw, ChevronLeft, ChevronRight } from "lucide-react"

type Props = {
  lineKey: string
}

export default function AudioRecorder({ lineKey }: Props) {
  const [status, setStatus] = useState<"idle" | "recording" | "recorded" | "playing" | "denied">("idle")
  const [url, setUrl] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(100)
  const [peaks, setPeaks] = useState<number[]>([])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    setStatus("idle")
    setUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setDuration(0)
    setTrimStart(0)
    setTrimEnd(100)
    setPeaks([])
    stopStream()
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
  }, [lineKey])

  useEffect(() => {
    let cancelled = false
    async function initPreview() {
      if (status !== "idle") return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
          },
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ sampleRate: 48000 })
        if (ctx.state === "suspended") await ctx.resume()
        if (cancelled) { try { ctx.close() } catch {}; return }
        contextRef.current = ctx
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 2048
        analyser.smoothingTimeConstant = 0.85
        src.connect(analyser)
        analyserRef.current = analyser
        drawLive()
      } catch {
        if (!cancelled) setStatus("denied")
      }
    }
    if (status === "idle" && !streamRef.current && !analyserRef.current) {
      initPreview()
    }
    return () => { cancelled = true }
  }, [lineKey, status])

  useEffect(() => {
    return () => {
      stopStream()
      if (url) URL.revokeObjectURL(url)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (audioRef.current) audioRef.current.pause()
      if (contextRef.current) {
        try { contextRef.current.close() } catch {}
      }
    }
  }, [url])

  function stopStream() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (analyserRef.current) analyserRef.current = null
  }

  function drawLive() {
    const canvas = liveCanvasRef.current
    const analyser = analyserRef.current
    if (!canvas || !analyser) {
      rafRef.current = requestAnimationFrame(drawLive)
      return
    }
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const bufferLength = analyser.fftSize
    const data = new Uint8Array(bufferLength)
    const cssW = rect.width
    const cssH = rect.height
    const draw = () => {
      if (!liveCanvasRef.current || !analyserRef.current) return
      rafRef.current = requestAnimationFrame(draw)
      analyser.getByteTimeDomainData(data)
      ctx.clearRect(0, 0, cssW, cssH)
      ctx.fillStyle = "#fff7ed"
      ctx.fillRect(0, 0, cssW, cssH)
      ctx.fillStyle = "rgba(124,92,255,0.06)"
      for (let i = 1; i < 5; i++) {
        ctx.fillRect(0, (cssH / 5) * i, cssW, 1)
      }
      let maxDev = 0
      for (let i = 0; i < bufferLength; i++) {
        const dev = Math.abs(data[i]! - 128)
        if (dev > maxDev) maxDev = dev
      }
      const gain = maxDev < 4 ? 1.9 : 1
      ctx.lineWidth = 3.5
      ctx.strokeStyle = "#7c5cff"
      ctx.lineCap = "round"
      ctx.lineJoin = "round"
      ctx.shadowColor = "rgba(124,92,255,0.28)"
      ctx.shadowBlur = 8
      ctx.beginPath()
      const slice = cssW / bufferLength
      let x = 0
      for (let i = 0; i < bufferLength; i++) {
        const v = ((data[i]! - 128) / 128) * gain
        const y = v * cssH * 0.38 + cssH / 2
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
        x += slice
      }
      ctx.stroke()
      ctx.shadowBlur = 0
      const grad = ctx.createLinearGradient(0, 0, 0, cssH)
      grad.addColorStop(0, "rgba(124,92,255,0.22)")
      grad.addColorStop(1, "rgba(255,77,106,0.16)")
      ctx.lineTo(cssW, cssH)
      ctx.lineTo(0, cssH)
      ctx.closePath()
      ctx.fillStyle = grad
      ctx.fill()
    }
    draw()
  }

  useEffect(() => {
    if (status === "recording" || status === "idle") {
      drawLive()
    }
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [status])

  function drawPeaks() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const rect = canvas.getBoundingClientRect()
    const cssW = rect.width
    const cssH = rect.height
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(cssW * dpr))
    const h = Math.max(1, Math.round(cssH * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, cssW, cssH)
    if (peaks.length === 0) return
    const barW = cssW / peaks.length
    const gap = Math.max(1, barW * 0.2)
    const bw = Math.max(3, barW - gap)
    for (let i = 0; i < peaks.length; i++) {
      const v = peaks[i]!
      const bh = Math.max(4, v * cssH * 0.78)
      const x = i * barW + gap / 2
      const y = (cssH - bh) / 2
      const pct = (i / peaks.length) * 100
      const inside = pct >= trimStart && pct <= trimEnd
      ctx.fillStyle = inside ? "#7c5cff" : "rgba(15,15,20,0.14)"
      const r = bw / 2
      ctx.beginPath()
      ctx.roundRect(x, y, bw, bh, r)
      ctx.fill()
      if (inside) {
        ctx.fillStyle = "rgba(255,255,255,0.55)"
        ctx.beginPath()
        ctx.roundRect(x, y, bw, 2.5, 1)
        ctx.fill()
      }
    }
    const sx = (trimStart / 100) * cssW
    const ex = (trimEnd / 100) * cssW
    ctx.fillStyle = "rgba(15,15,20,0.08)"
    ctx.fillRect(0, 0, sx, cssH)
    ctx.fillRect(ex, 0, cssW - ex, cssH)
    ctx.fillStyle = "#ffb830"
    ctx.beginPath()
    ctx.roundRect(sx - 6, 4, 12, cssH - 8, 6)
    ctx.fill()
    ctx.strokeStyle = "#0f0f14"
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = "#ffb830"
    ctx.beginPath()
    ctx.roundRect(ex - 6, 4, 12, cssH - 8, 6)
    ctx.fill()
    ctx.strokeStyle = "#0f0f14"
    ctx.stroke()
    ctx.strokeStyle = "rgba(255,184,48,0.9)"
    ctx.lineWidth = 2
    ctx.setLineDash([0, 0])
    ctx.beginPath()
    ctx.moveTo(sx, 0)
    ctx.lineTo(sx, cssH)
    ctx.moveTo(ex, 0)
    ctx.lineTo(ex, cssH)
    ctx.stroke()
  }

  useEffect(() => {
    drawPeaks()
  }, [peaks, trimStart, trimEnd])

  async function startRecording() {
    if (status === "recording") return
    try {
      let stream = streamRef.current
      let ctx = contextRef.current
      let analyser = analyserRef.current
      if (!stream || !ctx || !analyser) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
          },
        })
        streamRef.current = stream
        ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ sampleRate: 48000 })
        if (ctx.state === "suspended") await ctx.resume()
        contextRef.current = ctx
        const src = ctx.createMediaStreamSource(stream)
        analyser = ctx.createAnalyser()
        analyser.fftSize = 2048
        analyser.smoothingTimeConstant = 0.85
        src.connect(analyser)
        analyserRef.current = analyser
      } else {
        if (ctx.state === "suspended") await ctx.resume()
      }
      chunksRef.current = []
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4"
      const rec = new MediaRecorder(stream!, { mimeType: mime })
      recorderRef.current = rec
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop())
          streamRef.current = null
        }
        if (analyserRef.current) analyserRef.current = null
        if (contextRef.current) { try { contextRef.current.close() } catch {} ; contextRef.current = null }
        const blob = new Blob(chunksRef.current, { type: rec.mimeType })
        const nextUrl = URL.createObjectURL(blob)
        setUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return nextUrl
        })
        setStatus("recorded")
        try {
          const arr = await blob.arrayBuffer()
          const decodeCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
          const buf = await decodeCtx.decodeAudioData(arr.slice(0))
          const ch = buf.getChannelData(0)
          const total = ch.length
          const bars = 64
          const seg = Math.floor(total / bars)
          const next: number[] = []
          for (let i = 0; i < bars; i++) {
            let max = 0
            const start = i * seg
            const end = Math.min(start + seg, total)
            for (let j = start; j < end; j++) {
              const v = Math.abs(ch[j]!)
              if (v > max) max = v
            }
            next.push(Math.pow(max, 0.9))
          }
          const mx = Math.max(...next, 0.01)
          setPeaks(next.map((v) => v / mx))
          setDuration(buf.duration)
          setTrimStart(0)
          setTrimEnd(100)
          const audio = new Audio(nextUrl)
          audioRef.current = audio
          audio.onended = () => setStatus("recorded")
          try { decodeCtx.close() } catch {}
        } catch {
          setPeaks(Array.from({ length: 64 }, () => Math.random() * 0.6 + 0.2))
          setDuration(0)
        }
      }
      rec.start(100)
      setStatus("recording")
      drawLive()
    } catch {
      setStatus("denied")
    }
  }

  function stopRecording() {
    const rec = recorderRef.current
    if (rec && rec.state !== "inactive") {
      try { rec.stop() } catch {}
    }
  }

  function togglePlay() {
    const audio = audioRef.current
    if (!audio || !url) return
    if (status === "playing") {
      audio.pause()
      setStatus("recorded")
      return
    }
    const s = (trimStart / 100) * duration
    const e = (trimEnd / 100) * duration
    const playDur = Math.max(0, e - s)
    if (playDur <= 0.05) return
    audio.currentTime = s
    setStatus("playing")
    audio.onended = () => setStatus("recorded")
    const onTime = () => {
      if (audio.currentTime >= e) {
        audio.pause()
        setStatus("recorded")
        audio.removeEventListener("timeupdate", onTime)
      }
    }
    audio.addEventListener("timeupdate", onTime)
    audio.play().catch(() => setStatus("recorded"))
  }

  function reset() {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setPeaks([])
    setDuration(0)
    setTrimStart(0)
    setTrimEnd(100)
    stopStream()
    if (contextRef.current) { try { contextRef.current.close() } catch {} ; contextRef.current = null }
    setStatus("idle")
  }

  function handleWavePointer(e: React.PointerEvent<HTMLDivElement>) {
    if (peaks.length === 0 || duration <= 0) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const pct = (x / rect.width) * 100
    const distStart = Math.abs(pct - trimStart)
    const distEnd = Math.abs(pct - trimEnd)
    if (distStart < 9 || distEnd < 9) return
    const target = distStart < distEnd ? "start" : "end"
    const move = (ev: PointerEvent) => {
      const nx = ev.clientX - rect.left
      const npct = Math.max(0, Math.min(100, (nx / rect.width) * 100))
      if (target === "start") setTrimStart(Math.min(npct, trimEnd - 6))
      else setTrimEnd(Math.max(npct, trimStart + 6))
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  function handleHandleDrag(which: "start" | "end", e: React.PointerEvent) {
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const nx = ev.clientX - rect.left
      const npct = Math.max(0, Math.min(100, (nx / rect.width) * 100))
      if (which === "start") setTrimStart(Math.min(npct, trimEnd - 6))
      else setTrimEnd(Math.max(npct, trimStart + 6))
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  function formatSec(s: number) {
    const m = Math.floor(s / 60)
    const r = s % 60
    return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0")
  }
  void formatSec

  return (
    <div className="audio-recorder">
      {(status === "idle" || status === "recording") && (
        <div className={status === "recording" ? "audio-recording audio-recording--active" : "audio-recording"}>
          <div className="audio-wave-wrap">
            <canvas ref={liveCanvasRef} width={320} height={76} className={status === "recording" ? "audio-live-canvas audio-live-canvas--rec" : "audio-live-canvas"} />
          </div>
          <button type="button" className="btn btn-primary audio-record-btn" onClick={status === "idle" ? startRecording : stopRecording} aria-label={status === "idle" ? "Grabar" : "Detener"}>
            {status === "idle" ? <><Mic size={16} /> Grabar</> : <><Square size={16} /> Detener</>}
          </button>
        </div>
      )}
      {status === "denied" && (
        <div className="audio-denied">
          <span className="audio-denied-text">Micrófono bloqueado. Activá el permiso en el navegador y reintentá.</span>
          <button type="button" className="btn btn-ghost audio-retry" onClick={() => setStatus("idle")}>
            Permitir micrófono
          </button>
        </div>
      )}
      {(status === "recorded" || status === "playing") && url && (
        <div className="audio-playback">
          <div className="audio-wave-wrap" onPointerDown={handleWavePointer}>
            <canvas ref={canvasRef} width={320} height={76} className="audio-peaks-canvas" />
            <button type="button" className="audio-handle audio-handle--left" style={{ left: trimStart + "%" }} onPointerDown={(e) => handleHandleDrag("start", e)} aria-label="Inicio recorte"><ChevronLeft size={12} /></button>
            <button type="button" className="audio-handle audio-handle--right" style={{ left: trimEnd + "%" }} onPointerDown={(e) => handleHandleDrag("end", e)} aria-label="Fin recorte"><ChevronRight size={12} /></button>
          </div>
          <input type="range" min={0} max={100} value={trimStart} onChange={(e) => setTrimStart(Math.min(Number(e.target.value), trimEnd - 6))} className="audio-trim-input audio-trim-input--hidden" aria-label="Inicio" />
          <input type="range" min={0} max={100} value={trimEnd} onChange={(e) => setTrimEnd(Math.max(Number(e.target.value), trimStart + 6))} className="audio-trim-input audio-trim-input--hidden" aria-label="Fin" />
          <div className="audio-actions">
            <button type="button" className="btn btn-primary audio-play-big" onClick={togglePlay}>
              <span className="audio-play-icon">{status === "playing" ? <Pause size={16} /> : <Play size={16} />}</span>
              {status === "playing" ? "Pausar" : "Escuchar"}
            </button>
            <button type="button" className="btn btn-ghost audio-rerecord audio-rerecord--icon" onClick={reset} aria-label="Grabar de nuevo">
              <RotateCcw size={18} />
            </button>
          </div>

        </div>
      )}
    </div>
  )
}
