'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useFaceApi } from '@/lib/useFaceApi'

// ── Types ──────────────────────────────────────────────────────

interface KioskEmployee {
  id: string
  name: string
  face_descriptor: number[]
  photo_url: string | null
}

type KioskState =
  | 'company-input'
  | 'loading'
  | 'idle'
  | 'processing'
  | 'success'
  | 'already-done'
  | 'no-employees'
  | 'error'

interface PunchResult {
  employeeName: string
  punchType: string
  time: string
  latitude?: number
  longitude?: number
}

// ── Helpers ────────────────────────────────────────────────────

function fmtTime(d: Date) {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtDate(d: Date) {
  return d.toLocaleDateString('pt-BR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function todayStr() {
  return new Date().toISOString().split('T')[0]
}

function nowTimeStr() {
  return new Date().toTimeString().split(' ')[0]
}

/** Returns which field and label to fill next, or null if day is complete. */
function nextPunch(record: Record<string, unknown> | null): { field: string; label: string } | null {
  if (!record)                    return { field: 'entry_time',  label: 'Entrada' }
  if (!record.entry_time)         return { field: 'entry_time',  label: 'Entrada' }
  if (!record.break_start)        return { field: 'break_start', label: 'Início de Intervalo' }
  if (!record.break_end)          return { field: 'break_end',   label: 'Fim de Intervalo' }
  if (!record.exit_time)          return { field: 'exit_time',   label: 'Saída' }
  return null
}

// ── Main component ─────────────────────────────────────────────

function KioskInner() {
  const searchParams = useSearchParams()
  const { isLoaded, isLoading: modelsLoading, error: modelError, loadModels } = useFaceApi()
  const supabase = createClient()

  const initialCompany = searchParams.get('company') || ''

  const [companyInput, setCompanyInput] = useState('')
  const [companyId, setCompanyId] = useState(initialCompany)
  const [kioskState, setKioskState] = useState<KioskState>(
    initialCompany ? 'loading' : 'company-input'
  )
  const [currentTime, setCurrentTime] = useState(new Date())
  const [punchResult, setPunchResult] = useState<PunchResult | null>(null)
  const [employees, setEmployees] = useState<KioskEmployee[]>([])
  const [isMatcherReady, setIsMatcherReady] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  // Refs for values used inside intervals (avoid stale closures)
  const kioskStateRef    = useRef<KioskState>(initialCompany ? 'loading' : 'company-input')
  const faceapiRef       = useRef<typeof import('face-api.js') | null>(null)
  const faceMatcherRef   = useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const cooldownRef      = useRef<Map<string, number>>(new Map())
  const isProcessingRef  = useRef(false)
  const videoRef         = useRef<HTMLVideoElement>(null)
  const employeesRef     = useRef<KioskEmployee[]>([])
  const companyIdRef     = useRef(initialCompany)

  const setState = useCallback((s: KioskState) => {
    kioskStateRef.current = s
    setKioskState(s)
  }, [])

  // Sync refs
  useEffect(() => { employeesRef.current = employees }, [employees])
  useEffect(() => { companyIdRef.current = companyId }, [companyId])

  // ── Clock ──────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setCurrentTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  // ── Load faceapi module reference ──────────────────────────
  useEffect(() => {
    import('face-api.js').then(m => { faceapiRef.current = m })
  }, [])

  // ── Load models on mount ───────────────────────────────────
  useEffect(() => {
    loadModels()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Start webcam when company is set ──────────────────────
  useEffect(() => {
    if (!companyId) return
    startWebcam()
    return () => stopWebcam()
  }, [companyId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch employees once models + companyId are ready ─────
  useEffect(() => {
    if (!isLoaded || !companyId) return
    fetchEmployees()
  }, [isLoaded, companyId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Build FaceMatcher — unified guard for isLoaded + employees ───────────
  // Fixes race condition: if employees arrive before faceapiRef.current is
  // populated, this effect re-fires when isLoaded transitions to true,
  // ensuring buildFaceMatcher() is always attempted after both are ready.
  useEffect(() => {
    if (!isLoaded) return
    if (employees.length === 0) return
    if (isMatcherReady) return  // already built, avoid rebuild
    buildFaceMatcher()
  }, [isLoaded, employees.length, isMatcherReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Recognition loop ───────────────────────────────────────
  useEffect(() => {
    if (!isMatcherReady || !isLoaded) return
    const interval = setInterval(runDetection, 2000)
    return () => clearInterval(interval)
  }, [isMatcherReady, isLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Helpers ────────────────────────────────────────────────

  const startWebcam = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
      })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
    } catch {
      setErrorMsg('Não foi possível acessar a câmera.')
      setState('error')
    }
  }

  const stopWebcam = () => {
    const video = videoRef.current
    if (video?.srcObject) {
      ;(video.srcObject as MediaStream).getTracks().forEach(t => t.stop())
      video.srcObject = null
    }
  }

  const fetchEmployees = async () => {
    const { data, error } = await supabase
      .from('employees')
      .select('id, name, face_descriptor, photo_url')
      .eq('company_id', companyIdRef.current)
      .not('face_descriptor', 'is', null)

    if (error || !data || data.length === 0) {
      setState('no-employees')
      return
    }
    setEmployees(data as KioskEmployee[])
  }

  const buildFaceMatcher = async () => {
    // Self-heal: if faceapiRef wasn't populated yet (race condition), import now.
    // Module cache guarantees this is instant after loadModels() has resolved.
    if (!faceapiRef.current) {
      faceapiRef.current = await import('face-api.js')
    }
    const faceapi = faceapiRef.current

    console.log('[DEBUG] Building matcher with', employeesRef.current.length, 'employees')
    console.log('[DEBUG] faceapi loaded?', !!faceapi)

    if (!faceapi || employeesRef.current.length === 0) {
      console.log('[DEBUG] Matcher build SKIPPED — missing deps')
      return
    }

    const labeled = employeesRef.current.map(emp =>
      new faceapi.LabeledFaceDescriptors(emp.id, [new Float32Array(emp.face_descriptor)])
    )
    faceMatcherRef.current = new faceapi.FaceMatcher(labeled, 0.6)
    setIsMatcherReady(true)
    setState('idle')

    console.log('[DEBUG] Matcher built successfully with', labeled.length, 'labeled descriptors')
  }

  const runDetection = async () => {
    if (kioskStateRef.current !== 'idle') return
    if (isProcessingRef.current) return
    if (!videoRef.current || !faceapiRef.current || !faceMatcherRef.current) return

    isProcessingRef.current = true
    try {
      const faceapi = faceapiRef.current
      const detection = await faceapi
        .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptor()

      if (detection) {
        const match = faceMatcherRef.current.findBestMatch(detection.descriptor)
        console.log('[DEBUG] Match result:', match.label, 'distance:', match.distance)
        if (match.label !== 'unknown') {
          await handleRecognition(match.label)
        }
      }
    } catch (err) {
      console.error('Detection error:', err)
    } finally {
      isProcessingRef.current = false
    }
  }

  const handleRecognition = async (employeeId: string) => {
    // Cooldown — 30 s per employee
    const lastPunch = cooldownRef.current.get(employeeId)
    if (lastPunch && Date.now() - lastPunch < 30_000) return

    const employee = employeesRef.current.find(e => e.id === employeeId)
    if (!employee) return

    setState('processing')

    try {
      // Geolocation (best-effort)
      let latitude: number | undefined
      let longitude: number | undefined
      let accuracy: number | undefined
      try {
        const pos = await new Promise<GeolocationPosition>((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
        )
        latitude  = pos.coords.latitude
        longitude = pos.coords.longitude
        accuracy  = pos.coords.accuracy
      } catch { /* proceed without location */ }

      const today = todayStr()
      const now   = nowTimeStr()

      // Check today's record
      const { data: existingRecord } = await supabase
        .from('time_records')
        .select('id, entry_time, break_start, break_end, exit_time')
        .eq('company_id', companyIdRef.current)
        .eq('employee_id', employeeId)
        .eq('record_date', today)
        .maybeSingle()

      const punch = nextPunch(existingRecord as Record<string, unknown> | null)

      if (!punch) {
        // Day already closed
        setPunchResult({ employeeName: employee.name, punchType: 'Ponto do dia encerrado', time: now })
        setState('already-done')
        setTimeout(() => { setPunchResult(null); setState('idle') }, 3000)
        return
      }

      const geoFields = latitude !== undefined ? { latitude, longitude, accuracy } : {}

      if (!existingRecord) {
        await supabase.from('time_records').insert({
          company_id:  companyIdRef.current,
          employee_id: employeeId,
          record_date: today,
          entry_time:  now,
          punch_method: 'facial',
          status: 'present',
          ...geoFields,
        })
      } else {
        await supabase
          .from('time_records')
          .update({ [punch.field]: now, punch_method: 'facial', ...geoFields })
          .eq('id', (existingRecord as any).id) // eslint-disable-line @typescript-eslint/no-explicit-any
      }

      cooldownRef.current.set(employeeId, Date.now())
      setPunchResult({ employeeName: employee.name, punchType: punch.label, time: now, latitude, longitude })
      setState('success')
      setTimeout(() => { setPunchResult(null); setState('idle') }, 4000)
    } catch (err) {
      console.error('Punch error:', err)
      setState('idle')
    }
  }

  const handleCompanySubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!companyInput.trim()) return
    setCompanyId(companyInput.trim())
    setState('loading')
  }

  // ── Render: company input ──────────────────────────────────
  if (kioskState === 'company-input') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0d1b3e]">
        <div className="bg-white/10 backdrop-blur rounded-2xl p-8 w-full max-w-sm">
          <h1 className="text-2xl font-bold text-white mb-1 text-center">SIBOS Ponto</h1>
          <p className="text-blue-300 text-sm text-center mb-6">Sistema de Ponto Eletrônico</p>
          <form onSubmit={handleCompanySubmit} className="flex flex-col gap-4">
            <label className="text-blue-200 text-sm">ID da Empresa</label>
            <input
              type="text"
              value={companyInput}
              onChange={e => setCompanyInput(e.target.value)}
              placeholder="UUID da empresa"
              className="rounded-lg px-4 py-2 bg-white/20 text-white placeholder-blue-400 border border-blue-500 focus:outline-none focus:border-blue-200"
            />
            <button
              type="submit"
              className="bg-[#2e5fab] hover:bg-[#3a6fd1] text-white font-semibold py-2 rounded-lg transition"
            >
              Entrar
            </button>
          </form>
        </div>
      </div>
    )
  }

  // ── Render: kiosk ──────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#0d1b3e] text-white overflow-hidden">
      {/* Title */}
      <h1 className="text-xl font-bold tracking-widest text-blue-200 mb-4 uppercase">
        SIBOS Ponto Eletrônico
      </h1>

      {/* Webcam container */}
      <div className="relative w-[640px] max-w-[95vw] rounded-2xl overflow-hidden shadow-2xl border-2 border-[#2e5fab]">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-auto block bg-black"
        />

        {/* Loading */}
        {(kioskState === 'loading' || modelsLoading) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70">
            <div className="w-10 h-10 border-4 border-blue-400 border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-blue-200 text-sm">
              {modelsLoading ? 'Carregando modelos de IA...' : 'Inicializando...'}
            </p>
          </div>
        )}

        {/* Idle hint */}
        {kioskState === 'idle' && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent py-4 text-center pointer-events-none">
            <p className="text-blue-100 text-sm">Aproxime seu rosto para registrar o ponto</p>
          </div>
        )}

        {/* Processing */}
        {kioskState === 'processing' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60">
            <div className="w-10 h-10 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* Success */}
        {kioskState === 'success' && punchResult && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-green-950/95 text-center px-6">
            <div className="text-5xl mb-3">✅</div>
            <h2 className="text-2xl font-bold mb-1">Ponto registrado!</h2>
            <p className="text-xl font-semibold text-green-200">{punchResult.employeeName}</p>
            <p className="text-blue-200 mt-2">🕐 {punchResult.time}</p>
            <p className="text-green-300 text-lg mt-1">📍 {punchResult.punchType}</p>
            {punchResult.latitude !== undefined && (
              <p className="text-blue-400 text-xs mt-2">
                🌍 {punchResult.latitude.toFixed(5)}, {punchResult.longitude?.toFixed(5)}
              </p>
            )}
            <p className="text-blue-500 text-sm mt-5">Voltando em 4 segundos...</p>
          </div>
        )}

        {/* Already done */}
        {kioskState === 'already-done' && punchResult && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-blue-950/95 text-center px-6">
            <div className="text-5xl mb-3">ℹ️</div>
            <h2 className="text-xl font-bold mb-2">Ponto já registrado</h2>
            <p className="text-blue-200">{punchResult.employeeName}</p>
            <p className="text-blue-400 text-sm mt-1">{punchResult.punchType}</p>
            <p className="text-blue-500 text-sm mt-4">Voltando em 3 segundos...</p>
          </div>
        )}

        {/* No employees */}
        {kioskState === 'no-employees' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-yellow-950/95 text-center px-6">
            <div className="text-5xl mb-3">⚠️</div>
            <h2 className="text-xl font-bold mb-2">Nenhum colaborador cadastrado</h2>
            <p className="text-yellow-200 text-sm">
              Acesse{' '}
              <a href={`/setup?company=${companyId}`} className="underline">
                /setup
              </a>{' '}
              para cadastrar rostos.
            </p>
          </div>
        )}

        {/* Error */}
        {kioskState === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-950/95 text-center px-6">
            <div className="text-5xl mb-3">❌</div>
            <p className="text-red-200">{errorMsg || modelError}</p>
          </div>
        )}
      </div>

      {/* Clock */}
      <div className="mt-6 text-center">
        <p className="text-5xl font-mono font-bold tracking-widest">
          {fmtTime(currentTime)}
        </p>
        <p className="text-blue-300 mt-1 capitalize text-sm">{fmtDate(currentTime)}</p>
      </div>

      {/* Settings link */}
      <a
        href={`/setup?company=${companyId}`}
        className="mt-5 text-blue-500 hover:text-blue-300 text-xs transition flex items-center gap-1"
      >
        ⚙ Configurar
      </a>
    </div>
  )
}

export default function KioskPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#0d1b3e]">
          <div className="w-10 h-10 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <KioskInner />
    </Suspense>
  )
}
