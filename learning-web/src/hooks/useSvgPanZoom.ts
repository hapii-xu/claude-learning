import { useCallback, useEffect, useRef, useState } from 'react'

export interface PanZoomState {
  x: number
  y: number
  scale: number
}

export interface SvgPanZoom {
  wrapperRef: React.RefObject<HTMLDivElement | null>
  state: PanZoomState
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  fit: () => void
  setScale: (s: number) => void
}

const MIN_SCALE = 0.2
const MAX_SCALE = 4
const SCALE_STEP = 0.15

export function useSvgPanZoom(): SvgPanZoom {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<PanZoomState>({ x: 0, y: 0, scale: 1 })

  const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

  const zoomIn = useCallback(() => {
    setState(prev => ({ ...prev, scale: clamp(prev.scale + SCALE_STEP) }))
  }, [])

  const zoomOut = useCallback(() => {
    setState(prev => ({ ...prev, scale: clamp(prev.scale - SCALE_STEP) }))
  }, [])

  const reset = useCallback(() => {
    setState({ x: 0, y: 0, scale: 1 })
  }, [])

  const fit = useCallback(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const svg = wrapper.querySelector('svg')
    if (!svg) return
    const wW = wrapper.clientWidth
    const svgW = svg.getBoundingClientRect().width / (state.scale || 1)
    if (svgW <= 0) return
    const newScale = clamp(wW / svgW)
    setState({ x: 0, y: 0, scale: newScale })
  }, [state.scale])

  const setScale = useCallback((s: number) => {
    setState(prev => ({ ...prev, scale: clamp(s) }))
  }, [])

  // Ctrl/Meta + wheel → zoom; plain drag → pan
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    function onWheel(e: WheelEvent) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const delta = -e.deltaY * 0.002
        setState(prev => ({
          ...prev,
          scale: clamp(prev.scale + delta * prev.scale),
        }))
      }
    }

    wrapper.addEventListener('wheel', onWheel, { passive: false })
    return () => wrapper.removeEventListener('wheel', onWheel)
  }, [])

  // Drag to pan
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    let dragging = false
    let startX = 0
    let startY = 0
    let originX = 0
    let originY = 0

    const w = wrapper

    function onMouseDown(e: MouseEvent) {
      // Only pan on middle-button or when Alt is held
      if (e.button !== 1 && !e.altKey) return
      e.preventDefault()
      dragging = true
      startX = e.clientX
      startY = e.clientY
      setState(prev => {
        originX = prev.x
        originY = prev.y
        return prev
      })
      w.style.cursor = 'grabbing'
    }

    function onMouseMove(e: MouseEvent) {
      if (!dragging) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      setState(prev => ({ ...prev, x: originX + dx, y: originY + dy }))
    }

    function onMouseUp() {
      if (!dragging) return
      dragging = false
      w.style.cursor = ''
    }
    w.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      w.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // Double-click to reset
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const w = wrapper
    function onDblClick(e: MouseEvent) {
      // Don't intercept double-click on interactive SVG nodes
      const target = e.target as Element
      if (target.closest('[data-et]')) return
      reset()
    }
    w.addEventListener('dblclick', onDblClick)
    return () => w.removeEventListener('dblclick', onDblClick)
  }, [reset])

  return { wrapperRef, state, zoomIn, zoomOut, reset, fit, setScale }
}
