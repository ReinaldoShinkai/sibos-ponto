'use client'
import { useRef, useState } from 'react'

interface UseFaceApiReturn {
  isLoaded:   boolean
  isLoading:  boolean
  error:      string | null
  loadModels: () => Promise<void>
}

export function useFaceApi(): UseFaceApiReturn {
  const [isLoaded,  setIsLoaded]  = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const loadedRef = useRef(false)

  const loadModels = async () => {
    if (loadedRef.current) return
    setIsLoading(true)
    try {
      const faceapi = await import('face-api.js')
      const MODEL_URL = '/models'
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ])
      loadedRef.current = true
      setIsLoaded(true)
    } catch (err) {
      setError('Erro ao carregar modelos de reconhecimento facial.')
      console.error(err)
    } finally {
      setIsLoading(false)
    }
  }

  return { isLoaded, isLoading, error, loadModels }
}
