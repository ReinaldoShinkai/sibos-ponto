'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useFaceApi } from '@/lib/useFaceApi'

interface Employee {
  id: string
  name: string
  department: string | null
  photo_url: string | null
  face_descriptor: number[] | null
}

type SetupView = 'company-input' | 'employee-list' | 'camera'
type CaptureStatus = 'idle' | 'capturing' | 'processing' | 'success' | 'error'

function SetupInner() {
  const searchParams = useSearchParams()
  const { isLoaded, isLoading: modelsLoading, loadModels } = useFaceApi()
  const supabase = createClient()

  const initialCompany = searchParams.get('company') || ''
  const [view, setView] = useState<SetupView>(initialCompany ? 'employee-list' : 'company-input')
  const [companyInput, setCompanyInput] = useState('')
  const [companyId, setCompanyId] = useState(initialCompany)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [listLoading, setListLoading] = useState(!!initialCompany)
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null)
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>('idle')
  const [photoCount, setPhotoCount] = useState(0)
  const [statusMsg, setStatusMsg] = useState('')
  const [error, setError] = useState('')

  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const faceapiRef = useRef<typeof import('face-api.js') | null>(null)

  useEffect(() => {
    import('face-api.js').then(m => { faceapiRef.current = m })
  }, [])

  useEffect(() => {
    if (!companyId) return
    fetchEmployees(companyId)
  }, [companyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchEmployees = async (cid: string) => {
    setListLoading(true)
    setError('')
    const { data, error: err } = await supabase
      .from('employees')
      .select('id, name, department, photo_url, face_descriptor')
      .eq('company_id', cid)
      .eq('active', true)
      .order('name')
    setListLoading(false)
    if (err) { setError('Erro ao buscar colaboradores.'); return }
    setEmployees((data as Employee[]) || [])
    setView('employee-list')
  }

  const handleCompanySubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!companyInput.trim()) return
    setCompanyId(companyInput.trim())
  }

  const startCamera = async (emp: Employee) => {
    setSelectedEmployee(emp)
    setCaptureStatus('idle')
    setPhotoCount(0)
    setStatusMsg('')
    setError('')
    setView('camera')
    loadModels()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
    } catch {
      setError('Não foi possível acessar a câmera.')
    }
  }

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }

  const goBack = () => {
    stopCamera()
    setView('employee-list')
    setSelectedEmployee(null)
    setCaptureStatus('idle')
    setPhotoCount(0)
    setStatusMsg('')
    setError('')
  }

  const captureSequence = async () => {
    if (!videoRef.current || !faceapiRef.current || !isLoaded) {
      setStatusMsg('Aguarde os modelos de IA carregarem...')
      return
    }
    const faceapi = faceapiRef.current
    setCaptureStatus('capturing')
    setError('')
    const descriptors: Float32Array[] = []

    for (let i = 0; i < 3; i++) {
      setPhotoCount(i + 1)
      const canvas = document.createElement('canvas')
      canvas.width = videoRef.current.videoWidth
      canvas.height = videoRef.current.videoHeight
      canvas.getContext('2d')!.drawImage(videoRef.current, 0, 0)

      const detection = await faceapi
        .detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptor()

      if (!detection) {
        setError(`Rosto não detectado na foto ${i + 1}. Centralize o rosto e tente novamente.`)
        setCaptureStatus('error')
        setPhotoCount(0)
        return
      }
      descriptors.push(detection.descriptor)
      if (i < 2) await new Promise(r => setTimeout(r, 1000))
    }

    setCaptureStatus('processing')
    setStatusMsg('Calculando descritor facial...')

    const avgDescriptor = descriptors[0].map((_, idx) =>
      descriptors.reduce((sum, d) => sum + d[idx], 0) / descriptors.length
    )

    const { error: updateErr } = await supabase
      .from('employees')
      .update({ face_descriptor: Array.from(avgDescriptor) })
      .eq('id', selectedEmployee!.id)

    if (updateErr) {
      setError('Erro ao salvar o cadastro facial. Tente novamente.')
      setCaptureStatus('error')
      return
    }

    setEmployees(prev =>
      prev.map(e =>
        e.id === selectedEmployee!.id
          ? { ...e, face_descriptor: Array.from(avgDescriptor) }
          : e
      )
    )
    setCaptureStatus('success')
    setStatusMsg('✓ Rosto cadastrado com sucesso!')
  }

  // ── Company input ──────────────────────────────────────────────
  if (view === 'company-input') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0d1b3e]">
        <div className="bg-white/10 backdrop-blur rounded-2xl p-8 w-full max-w-sm">
          <h1 className="text-2xl font-bold text-white mb-1 text-center">SIBOS Ponto</h1>
          <p className="text-blue-300 text-sm text-center mb-6">Configuração de colaboradores</p>
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
              Buscar Colaboradores
            </button>
          </form>
          {error && <p className="text-red-300 text-sm mt-4 text-center">{error}</p>}
        </div>
      </div>
    )
  }

  // ── Camera view ────────────────────────────────────────────────
  if (view === 'camera') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#0d1b3e] text-white px-4">
        <div className="w-full max-w-lg">
          <button
            onClick={goBack}
            className="text-blue-300 hover:text-white transition mb-4 flex items-center gap-1 text-sm"
          >
            ← Voltar para lista
          </button>

          <h2 className="text-xl font-bold mb-0.5">Cadastro Facial</h2>
          <p className="text-blue-300 text-sm mb-4">{selectedEmployee?.name}</p>

          <div className="relative rounded-2xl overflow-hidden border-2 border-[#2e5fab] shadow-xl bg-black mb-5">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-auto block"
            />
            {modelsLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70">
                <div className="w-8 h-8 border-4 border-blue-400 border-t-transparent rounded-full animate-spin mb-2" />
                <p className="text-blue-200 text-sm">Carregando modelos de IA...</p>
              </div>
            )}
            {captureStatus === 'capturing' && (
              <div className="absolute top-3 right-3 bg-black/70 backdrop-blur rounded-full px-3 py-1 text-sm font-bold">
                {photoCount}/3
              </div>
            )}
          </div>

          {captureStatus === 'success' ? (
            <div className="text-center">
              <p className="text-green-400 text-lg font-semibold mb-4">{statusMsg}</p>
              <button
                onClick={goBack}
                className="bg-[#2e5fab] hover:bg-[#3a6fd1] text-white font-semibold px-8 py-2 rounded-xl transition"
              >
                Voltar para lista
              </button>
            </div>
          ) : (
            <div className="text-center space-y-3">
              <button
                onClick={captureSequence}
                disabled={
                  captureStatus === 'capturing' ||
                  captureStatus === 'processing' ||
                  !isLoaded
                }
                className="bg-[#2e5fab] hover:bg-[#3a6fd1] disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-10 py-3 rounded-xl transition text-lg"
              >
                {captureStatus === 'capturing'
                  ? `Capturando ${photoCount}/3...`
                  : captureStatus === 'processing'
                  ? 'Processando...'
                  : 'Capturar Foto'}
              </button>
              {error && <p className="text-red-300 text-sm">{error}</p>}
              {statusMsg && (
                <p className="text-blue-300 text-sm">{statusMsg}</p>
              )}
              <p className="text-blue-400 text-xs">
                Serão tiradas 3 fotos automaticamente com 1 segundo de intervalo.
              </p>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Employee list ──────────────────────────────────────────────
  const registeredCount = employees.filter(e => e.face_descriptor).length

  return (
    <div className="min-h-screen bg-[#0d1b3e] text-white">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Configuração</h1>
            <p className="text-blue-300 text-sm mt-0.5">Cadastro de colaboradores</p>
          </div>
          <a
            href={`/kiosk?company=${companyId}`}
            className="text-blue-400 hover:text-white text-sm transition mt-1"
          >
            → Ir para Kiosk
          </a>
        </div>

        {listLoading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <p className="text-red-300 text-center py-12">{error}</p>
        ) : employees.length === 0 ? (
          <p className="text-blue-300 text-center py-12">
            Nenhum colaborador ativo encontrado para esta empresa.
          </p>
        ) : (
          <>
            <p className="text-blue-400 text-sm mb-4">
              {employees.length} colaborador{employees.length !== 1 ? 'es' : ''} &middot;{' '}
              <span className="text-green-400">{registeredCount} com facial cadastrado</span>
              {registeredCount < employees.length && (
                <span className="text-gray-400">
                  {' '}· {employees.length - registeredCount} sem cadastro
                </span>
              )}
            </p>
            <div className="space-y-3">
              {employees.map(emp => (
                <div
                  key={emp.id}
                  className="flex items-center justify-between bg-white/10 hover:bg-white/[0.13] rounded-xl px-4 py-3 transition"
                >
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{emp.name}</p>
                    {emp.department && (
                      <p className="text-blue-300 text-sm">{emp.department}</p>
                    )}
                    <span
                      className={`inline-block text-xs mt-1 px-2 py-0.5 rounded-full font-medium ${
                        emp.face_descriptor
                          ? 'bg-green-900/70 text-green-300'
                          : 'bg-gray-700/70 text-gray-400'
                      }`}
                    >
                      {emp.face_descriptor ? '✓ Facial cadastrado' : '⚠ Sem cadastro facial'}
                    </span>
                  </div>
                  <button
                    onClick={() => startCamera(emp)}
                    className="ml-4 shrink-0 bg-[#2e5fab] hover:bg-[#3a6fd1] text-white text-sm font-medium px-4 py-1.5 rounded-lg transition"
                  >
                    {emp.face_descriptor ? 'Recadastrar' : 'Cadastrar'}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function SetupPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#0d1b3e]">
          <div className="w-10 h-10 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <SetupInner />
    </Suspense>
  )
}
