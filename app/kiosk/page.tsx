'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useFaceApi } from '@/lib/useFaceApi'

// ── Types ──────────────────────────────────────────────────────

interface KioskEmployee {
  id: string
  name: string
  department: string | null
  face_descriptor: number[]
  photo_url: string | null
}

type KioskState =
  | 'company-input'
  | 'loading'
  | 'idle'
  | 'confirming'   // Etapa 1: novo estado intermediário
  | 'success'
  | 'no-employees'
  | 'error'

interface PunchResult {
  punchType: string
  time: string
  latitude?: number
  longitude?: number
  accuracy?: number
}

interface LastPunch {
  label: string
  time: string
  date: string
}

// Etapa 1: registro do dia para controle dos botões
interface TodayRecord {
  entry_time:  string | null
  break_start: string | null
  break_end:   string | null
  exit_time:   string | null
}

interface PendingPunch {
  id:         string
  employeeId: string
  companyId:  string
  recordDate: string
  field:      string
  time:       string
  latitude?:  number
  longitude?: number
  accuracy?:  number
  timestamp:  number
  attempts:   number
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

function formatarDataRelativa(dateStr: string): string {
  const today = todayStr()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toISOString().split('T')[0]

  if (dateStr === today) return 'hoje'
  if (dateStr === yesterdayStr) return 'ontem'
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit',
  })
}

// ── Offline queue (localStorage) ────────────────────────────────

const QUEUE_KEY = 'sibos_ponto_pending_queue'

function getQueue(): PendingPunch[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveQueue(queue: PendingPunch[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch { /* storage full or unavailable */ }
}

function addToQueue(punch: Omit<PendingPunch, 'id' | 'timestamp' | 'attempts'>) {
  const queue = getQueue()
  queue.push({ ...punch, id: crypto.randomUUID(), timestamp: Date.now(), attempts: 0 })
  saveQueue(queue)
}

// ── Avatar component ───────────────────────────────────────────

function EmployeeAvatar({ name, photoUrl }: { name: string; photoUrl?: string | null }) {
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name}
        className="w-24 h-24 rounded-full object-cover border-4 border-white/20"
      />
    )
  }

  const initials = name.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase()
  const colors = ['#2e5fab', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4']
  const bg = colors[name.charCodeAt(0) % colors.length]

  return (
    <div
      className="w-24 h-24 rounded-full flex items-center justify-center text-3xl font-bold text-white border-4 border-white/20"
      style={{ backgroundColor: bg }}
    >
      {initials}
    </div>
  )
}

// ── Labels de cada campo ───────────────────────────────────────

const PUNCH_LABELS: Record<string, string> = {
  entry_time:  'Entrada',
  break_start: 'Início de Intervalo',
  break_end:   'Retorno do Intervalo',
  exit_time:   'Saída',
}

// ── Main component ─────────────────────────────────────────────

function KioskInner() {
  const searchParams = useSearchParams()
  const { isLoaded, isLoading: modelsLoading, error: modelError, loadModels } = useFaceApi()

  const initialCompany = searchParams.get('company') || ''

  const [companyInput, setCompanyInput]             = useState('')
  const [companyId, setCompanyId]                   = useState(initialCompany)
  const [kioskState, setKioskState]                 = useState<KioskState>(
    initialCompany ? 'loading' : 'company-input'
  )
  const [currentTime, setCurrentTime]               = useState(new Date())
  const [punchResult, setPunchResult]               = useState<PunchResult | null>(null)
  const [recognizedEmployee, setRecognizedEmployee] = useState<KioskEmployee | null>(null)
  const [lastPunch, setLastPunch]                   = useState<LastPunch | null>(null)
  // Etapa 1: novos estados
  const [confirmingEmployee, setConfirmingEmployee] = useState<KioskEmployee | null>(null)
  const [todayRecord, setTodayRecord]               = useState<TodayRecord | null>(null)
  const [isPaused, setIsPaused]                     = useState(false)
  const [employees, setEmployees]                   = useState<KioskEmployee[]>([])
  const [isMatcherReady, setIsMatcherReady]         = useState(false)
  const [errorMsg, setErrorMsg]                     = useState('')
  const [pendingCount, setPendingCount]             = useState(0)

  const kioskStateRef   = useRef<KioskState>(initialCompany ? 'loading' : 'company-input')
  const faceapiRef      = useRef<typeof import('face-api.js') | null>(null)
  const faceMatcherRef  = useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const cooldownRef     = useRef<Map<string, number>>(new Map())
  const isProcessingRef = useRef(false)
  const videoRef        = useRef<HTMLVideoElement>(null)
  const employeesRef    = useRef<KioskEmployee[]>([])
  const companyIdRef    = useRef(initialCompany)
  const supabaseRef     = useRef(createClient())
  // Etapa 2: geo capturado no reconhecimento, consumido no confirmPunch
  const geoDataRef      = useRef<{ latitude: number; longitude: number; accuracy: number } | null>(null)

  const setState = useCallback((s: KioskState) => {
    kioskStateRef.current = s
    setKioskState(s)
  }, [])

  useEffect(() => { employeesRef.current = employees }, [employees])
  useEffect(() => { companyIdRef.current = companyId }, [companyId])

  // ── Offline sync ───────────────────────────────────────────

  const syncQueue = useCallback(async () => {
    const queue = getQueue()
    if (queue.length === 0) { setPendingCount(0); return }

    const supabase = supabaseRef.current
    const remaining: PendingPunch[] = []

    for (const punch of queue) {
      try {
        const { data: existing } = await supabase
          .from('time_records')
          .select('id')
          .eq('employee_id', punch.employeeId)
          .eq('company_id', punch.companyId)
          .eq('record_date', punch.recordDate)
          .maybeSingle()

        const writeData: Record<string, unknown> = {
          [punch.field]: punch.time,
          punch_method: 'facial',
          ...(punch.latitude !== undefined && {
            latitude: punch.latitude, longitude: punch.longitude, accuracy: punch.accuracy,
          }),
        }

        if (existing) {
          await supabase
            .from('time_records')
            .update(writeData)
            .eq('id', (existing as any).id) // eslint-disable-line @typescript-eslint/no-explicit-any
        } else {
          await supabase.from('time_records').insert({
            company_id: punch.companyId, employee_id: punch.employeeId,
            record_date: punch.recordDate, status: 'present', ...writeData,
          })
        }

        console.log('[SYNC] Punch synced:', punch.id)
      } catch (err) {
        punch.attempts += 1
        if (punch.attempts < 10) remaining.push(punch)
        else console.error('[SYNC] Punch discarded after 10 attempts:', punch, err)
      }
    }

    saveQueue(remaining)
    setPendingCount(remaining.length)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    syncQueue()
    const interval = setInterval(syncQueue, 15_000)
    window.addEventListener('online', syncQueue)
    return () => { clearInterval(interval); window.removeEventListener('online', syncQueue) }
  }, [syncQueue])

  // ── Clock ──────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setCurrentTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  // ── Load faceapi module reference ──────────────────────────
  useEffect(() => {
    import('face-api.js').then(m => { faceapiRef.current = m })
  }, [])

  // ── Load models ────────────────────────────────────────────
  useEffect(() => { loadModels() }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Build FaceMatcher ──────────────────────────────────────
  useEffect(() => {
    if (!isLoaded || employees.length === 0 || isMatcherReady) return
    buildFaceMatcher()
  }, [isLoaded, employees.length, isMatcherReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Recognition loop — pausa enquanto confirming está visível ─
  // Etapa 1: isPaused adicionado como dependência
  useEffect(() => {
    if (!isMatcherReady || !isLoaded || isPaused) return
    const interval = setInterval(runDetection, 2000)
    return () => clearInterval(interval)
  }, [isMatcherReady, isLoaded, isPaused]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Core functions ─────────────────────────────────────────

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
    const { data, error } = await supabaseRef.current
      .from('employees')
      .select('id, name, department, face_descriptor, photo_url')
      .eq('company_id', companyIdRef.current)
      .not('face_descriptor', 'is', null)

    if (error || !data || data.length === 0) {
      setState('no-employees')
      return
    }
    setEmployees(data as KioskEmployee[])
  }

  const getLastPunch = async (employeeId: string): Promise<LastPunch | null> => {
    try {
      const { data } = await supabaseRef.current
        .from('time_records')
        .select('record_date, entry_time, break_start, break_end, exit_time')
        .eq('employee_id', employeeId)
        .order('record_date', { ascending: false })
        .limit(2)

      if (!data || data.length === 0) return null

      const previous = data.find((r: any) => r.record_date !== todayStr()) as Record<string, any> | undefined // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!previous) return null

      const fields = [
        { key: 'exit_time',   label: 'Saída' },
        { key: 'break_end',   label: 'Retorno' },
        { key: 'break_start', label: 'Intervalo' },
        { key: 'entry_time',  label: 'Entrada' },
      ]
      for (const f of fields) {
        if (previous[f.key]) {
          return { label: f.label, time: previous[f.key] as string, date: previous.record_date as string }
        }
      }
    } catch { /* best-effort */ }
    return null
  }

  const buildFaceMatcher = async () => {
    if (!faceapiRef.current) faceapiRef.current = await import('face-api.js')
    const faceapi = faceapiRef.current

    console.log('[DEBUG] Building matcher with', employeesRef.current.length, 'employees')
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
    console.log('[DEBUG] Matcher built with', labeled.length, 'descriptors')
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
        if (match.label !== 'unknown') await handleRecognition(match.label)
      }
    } catch (err) {
      console.error('Detection error:', err)
    } finally {
      isProcessingRef.current = false
    }
  }

  // Etapa 2: handleRecognition agora vai para 'confirming'
  const handleRecognition = async (employeeId: string) => {
    const lastCooldown = cooldownRef.current.get(employeeId)
    if (lastCooldown && Date.now() - lastCooldown < 30_000) return

    const employee = employeesRef.current.find(e => e.id === employeeId)
    if (!employee) return

    // Pausa detecção imediatamente — isPaused vai limpar o interval no próximo render
    setIsPaused(true)

    // Capturar geolocalização (best-effort) e armazenar no ref para uso em confirmPunch
    geoDataRef.current = null
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
      )
      geoDataRef.current = {
        latitude:  pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy:  pos.coords.accuracy,
      }
    } catch { /* proceed without location */ }

    // Buscar registro de hoje para saber o status de cada botão
    let record: TodayRecord | null = null
    try {
      const { data } = await supabaseRef.current
        .from('time_records')
        .select('entry_time, break_start, break_end, exit_time')
        .eq('employee_id', employeeId)
        .eq('company_id', companyIdRef.current)
        .eq('record_date', todayStr())
        .maybeSingle()
      record = data as TodayRecord | null
    } catch {
      record = null // Offline: só ENTRADA ficará habilitada
    }

    // Buscar último ponto do dia anterior (contexto)
    const last = await getLastPunch(employeeId)
    setLastPunch(last)

    setConfirmingEmployee(employee)
    setTodayRecord(record)
    setState('confirming')
  }

  // Etapa 2: colaborador escolhe qual ponto registrar
  const confirmPunch = (field: 'entry_time' | 'break_start' | 'break_end' | 'exit_time') => {
    if (!confirmingEmployee) return

    const time = nowTimeStr()
    const geo  = geoDataRef.current

    addToQueue({
      employeeId: confirmingEmployee.id,
      companyId:  companyIdRef.current,
      recordDate: todayStr(),
      field,
      time,
      latitude:   geo?.latitude,
      longitude:  geo?.longitude,
      accuracy:   geo?.accuracy,
    })

    cooldownRef.current.set(confirmingEmployee.id, Date.now())
    setRecognizedEmployee(confirmingEmployee)
    setPunchResult({
      punchType: PUNCH_LABELS[field],
      time,
      latitude:  geo?.latitude,
      longitude: geo?.longitude,
      accuracy:  geo?.accuracy,
    })
    setState('success')

    syncQueue()

    setTimeout(() => {
      setPunchResult(null)
      setRecognizedEmployee(null)
      setLastPunch(null)
      setConfirmingEmployee(null)
      setTodayRecord(null)
      setIsPaused(false)
      setState('idle')
    }, 4000)
  }

  // Etapa 2: colaborador cancela (reconhecimento errado)
  const cancelConfirmation = () => {
    setConfirmingEmployee(null)
    setTodayRecord(null)
    setLastPunch(null)
    setIsPaused(false)
    setState('idle')
  }

  const handleCompanySubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!companyInput.trim()) return
    setCompanyId(companyInput.trim())
    setState('loading')
  }

  // ── Badge de sincronização pendente ────────────────────────
  const PendingBadge = pendingCount > 0 ? (
    <div className="fixed top-2 right-2 bg-amber-500/90 text-white text-xs px-3 py-1 rounded-full flex items-center gap-1 z-50">
      <span className="animate-pulse">●</span>
      {pendingCount} ponto(s) sincronizando...
    </div>
  ) : null

  // ── Render: company input ──────────────────────────────────
  if (kioskState === 'company-input') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-[#0d1b3e] to-[#1a2f5c]">
        <div className="bg-white/10 backdrop-blur rounded-2xl p-8 w-full max-w-sm border border-white/10">
          <div className="flex items-center justify-center gap-2 mb-6">
            <div className="w-8 h-8 rounded bg-[#2e5fab] flex items-center justify-center text-white font-bold text-sm">S</div>
            <h1 className="text-xl font-bold text-white tracking-wide">SIBOS PONTO ELETRÔNICO</h1>
          </div>
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

  // ── Render: confirming screen (Etapa 3) ────────────────────
  if (kioskState === 'confirming' && confirmingEmployee) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-[#0d1b3e] to-[#1a2f5c] flex flex-col items-center justify-center p-6">
        {PendingBadge}

        <div className="w-full max-w-sm">

          {/* Colaborador identificado */}
          <div className="bg-white/5 backdrop-blur rounded-2xl border border-white/10 p-6 mb-4 text-center">
            <div className="flex justify-center mb-3">
              <EmployeeAvatar name={confirmingEmployee.name} photoUrl={confirmingEmployee.photo_url} />
            </div>
            <h2 className="text-white text-xl font-bold">{confirmingEmployee.name}</h2>
            {confirmingEmployee.department && (
              <p className="text-blue-300 text-sm">{confirmingEmployee.department}</p>
            )}
            {lastPunch && (
              <p className="text-white/40 text-xs mt-2">
                Último: {lastPunch.label} {formatarDataRelativa(lastPunch.date)} às {lastPunch.time}
              </p>
            )}
          </div>

          {/* 4 botões de ponto */}
          <p className="text-white/60 text-sm text-center mb-3">Selecione o que deseja registrar:</p>

          <div className="grid grid-cols-2 gap-3">

            <button
              onClick={() => confirmPunch('entry_time')}
              disabled={!!todayRecord?.entry_time}
              className="flex flex-col items-center justify-center gap-1 py-5 rounded-xl font-bold text-white bg-green-600 hover:bg-green-700 disabled:bg-white/10 disabled:text-white/30 transition"
            >
              <span className="text-2xl">▶</span>
              <span>ENTRADA</span>
              {todayRecord?.entry_time && (
                <span className="text-xs font-normal opacity-70">{todayRecord.entry_time.slice(0, 5)}</span>
              )}
            </button>

            <button
              onClick={() => confirmPunch('break_start')}
              disabled={!todayRecord?.entry_time || !!todayRecord?.break_start}
              className="flex flex-col items-center justify-center gap-1 py-5 rounded-xl font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:bg-white/10 disabled:text-white/30 transition"
            >
              <span className="text-2xl">⏸</span>
              <span>INTERVALO</span>
              {todayRecord?.break_start && (
                <span className="text-xs font-normal opacity-70">{todayRecord.break_start.slice(0, 5)}</span>
              )}
            </button>

            <button
              onClick={() => confirmPunch('break_end')}
              disabled={!todayRecord?.break_start || !!todayRecord?.break_end}
              className="flex flex-col items-center justify-center gap-1 py-5 rounded-xl font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:bg-white/10 disabled:text-white/30 transition"
            >
              <span className="text-2xl">▶</span>
              <span>RETORNO</span>
              {todayRecord?.break_end && (
                <span className="text-xs font-normal opacity-70">{todayRecord.break_end.slice(0, 5)}</span>
              )}
            </button>

            <button
              onClick={() => confirmPunch('exit_time')}
              disabled={!todayRecord?.entry_time || !!todayRecord?.exit_time}
              className="flex flex-col items-center justify-center gap-1 py-5 rounded-xl font-bold text-white bg-red-600 hover:bg-red-700 disabled:bg-white/10 disabled:text-white/30 transition"
            >
              <span className="text-2xl">■</span>
              <span>SAÍDA</span>
              {todayRecord?.exit_time && (
                <span className="text-xs font-normal opacity-70">{todayRecord.exit_time.slice(0, 5)}</span>
              )}
            </button>

          </div>

          <button
            onClick={cancelConfirmation}
            className="w-full mt-4 text-white/40 text-sm hover:text-white/60 transition"
          >
            Não é você? Cancelar
          </button>

        </div>
      </div>
    )
  }

  // ── Render: success screen ─────────────────────────────────
  if (kioskState === 'success' && punchResult && recognizedEmployee) {
    const isPositivePunch =
      punchResult.punchType === 'Entrada' || punchResult.punchType === 'Retorno do Intervalo'

    return (
      <div className="min-h-screen bg-gradient-to-b from-[#0d1b3e] to-[#1a2f5c] flex flex-col items-center justify-center p-6">
        {PendingBadge}

        <div className="w-full max-w-sm bg-white/5 backdrop-blur rounded-2xl border border-white/10 p-8 text-center">
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded-full bg-green-500 flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>

          <p className="text-green-400 text-sm font-semibold mb-6">Ponto registrado com sucesso</p>

          <div className="flex justify-center mb-3">
            <EmployeeAvatar name={recognizedEmployee.name} photoUrl={recognizedEmployee.photo_url} />
          </div>

          <h2 className="text-white text-xl font-bold">{recognizedEmployee.name}</h2>
          {recognizedEmployee.department && (
            <p className="text-blue-300 text-sm mb-4">{recognizedEmployee.department}</p>
          )}

          <div className="bg-white/10 rounded-xl p-4 mb-4 mt-3">
            <div className="flex items-center justify-center gap-2 text-base font-bold text-white mb-1">
              <span className={isPositivePunch ? 'text-green-400' : 'text-amber-400'}>●</span>
              {punchResult.punchType}
            </div>
            <div className="text-2xl font-mono text-white">{punchResult.time}</div>
          </div>

          {lastPunch && (
            <p className="text-white/50 text-xs mb-3">
              Último ponto: {lastPunch.label} {formatarDataRelativa(lastPunch.date)} às {lastPunch.time}
            </p>
          )}

          {punchResult.accuracy !== undefined && (
            <div className="flex items-center justify-center gap-1 text-white/40 text-xs">
              📍 Precisão de {punchResult.accuracy.toFixed(0)}m
            </div>
          )}

          <p className="text-blue-300/60 text-xs mt-4">Voltando em 4 segundos...</p>
        </div>
      </div>
    )
  }

  // ── Render: main kiosk — idle / loading / error ────────────
  return (
    <div className="min-h-screen bg-gradient-to-b from-[#0d1b3e] to-[#1a2f5c] flex flex-col items-center justify-center p-6">
      {PendingBadge}

      <div className="flex items-center gap-2 mb-8">
        <div className="w-8 h-8 rounded bg-[#2e5fab] flex items-center justify-center text-white font-bold text-sm">S</div>
        <h1 className="text-xl font-bold text-white tracking-wide">SIBOS PONTO ELETRÔNICO</h1>
      </div>

      <div className="relative w-full max-w-md aspect-[4/3] rounded-2xl overflow-hidden border-2 border-blue-400/30 shadow-2xl">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover bg-black"
        />

        {(kioskState === 'loading' || modelsLoading) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70">
            <div className="w-10 h-10 border-4 border-blue-400 border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-blue-200 text-sm">
              {modelsLoading ? 'Carregando modelos de IA...' : 'Inicializando...'}
            </p>
          </div>
        )}

        {kioskState === 'idle' && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent py-4 text-center pointer-events-none">
            <p className="text-white text-sm font-medium">
              Aproxime seu rosto para registrar o ponto
            </p>
          </div>
        )}

        {kioskState === 'no-employees' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-yellow-950/95 text-center px-6">
            <div className="text-5xl mb-3">⚠️</div>
            <h2 className="text-xl font-bold text-white mb-2">Nenhum colaborador cadastrado</h2>
            <p className="text-yellow-200 text-sm">
              Acesse{' '}
              <a href={`/setup?company=${companyId}`} className="underline">/setup</a>
              {' '}para cadastrar rostos.
            </p>
          </div>
        )}

        {kioskState === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-950/95 text-center px-6">
            <div className="text-5xl mb-3">❌</div>
            <p className="text-red-200">{errorMsg || modelError}</p>
          </div>
        )}
      </div>

      <div className="mt-8 text-center">
        <div className="text-6xl font-bold text-white tracking-tight font-mono">
          {fmtTime(currentTime)}
        </div>
        <div className="text-blue-300 text-sm mt-1">{fmtDate(currentTime)}</div>
      </div>

      <a
        href={`/setup?company=${companyId}`}
        className="mt-6 text-blue-400/60 text-xs hover:text-blue-400 transition"
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
