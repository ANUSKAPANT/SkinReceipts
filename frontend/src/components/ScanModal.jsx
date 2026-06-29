import { useEffect, useRef, useState } from 'react'
import { createWorker } from 'tesseract.js'
import { GUIDE_BOX, binarizeForOcr, cleanOcrText, countIngredients, loadOrientedCanvas } from '../lib/ocr'

export default function ScanModal({ onClose, onSample, onExtract }) {
  const fileInputRef = useRef(null)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const sourceCanvasRef = useRef(null) // full-res oriented photo, used for cropping
  const imgRef = useRef(null)          // the <img> shown during selection

  const [phase, setPhase] = useState('idle') // idle | camera | cropping | reading | review | error
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState(null)
  const [photoUrl, setPhotoUrl] = useState(null)  // full photo (cropping) or crop (review)
  const [videoAspect, setVideoAspect] = useState(4 / 3)
  const [ocrText, setOcrText] = useState('')
  const [incomplete, setIncomplete] = useState(false)
  const [sel, setSel] = useState(null)       // current selection rect, in displayed-img px
  const draggingRef = useRef(null)           // {x, y} drag origin, in displayed-img px

  useEffect(() => {
    if (phase !== 'camera') {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [phase])
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), [])

  useEffect(() => {
    if (phase === 'camera' && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
    }
  }, [phase])

  function resetToIdle() {
    setPhase('idle')
    setErrorMsg(null)
    setOcrText('')
    setIncomplete(false)
    setPhotoUrl(null)
    setSel(null)
    draggingRef.current = null
  }

  async function openCamera() {
    setErrorMsg(null)
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })
      setPhase('camera')
    } catch {
      setErrorMsg("Couldn't access the camera — check your browser's camera permission, or upload a photo instead.")
      setPhase('error')
    }
  }

  async function runOcr(imageSource, psm = 6) {
    setPhase('reading')
    setProgress(0)
    setErrorMsg(null)
    try {
      const worker = await createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') setProgress(Math.round(m.progress * 100))
        },
      })
      // No tessedit_char_whitelist: with the LSTM engine it confines the beam
      // search and truncates/garbles whole lines (it regressed full-list reads
      // to ~4 mangled lines). Stray edge symbols are cleaned up afterwards
      // instead, and fuzzy matching in /api/check corrects the rest.
      await worker.setParameters({ tessedit_pageseg_mode: String(psm) })
      const { data } = await worker.recognize(imageSource)
      await worker.terminate()
      return data
    } catch {
      setPhase('error')
      setErrorMsg('Something went wrong reading that photo. Try again.')
      return null
    }
  }

  function capture() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const vw = video.videoWidth
    const vh = video.videoHeight
    const cropX = (GUIDE_BOX.left / 100) * vw
    const cropY = (GUIDE_BOX.top / 100) * vh
    const cropW = (GUIDE_BOX.width / 100) * vw
    const cropH = (GUIDE_BOX.height / 100) * vh
    const canvas = document.createElement('canvas')
    canvas.width = cropW
    canvas.height = cropH
    canvas.getContext('2d').drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)
    setPhotoUrl(canvas.toDataURL('image/jpeg', 0.92))
    runOcr(canvas, 6).then((data) => {
      if (!data) return
      const { text, complete } = cleanOcrText(data.text)
      if (!text) {
        setPhase('error')
        setErrorMsg("Couldn't find readable text — try again with the ingredients list filling the box.")
        return
      }
      setOcrText(text)
      setIncomplete(!complete)
      setPhase('review')
    })
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    let oriented
    try {
      oriented = await loadOrientedCanvas(file)
    } catch {
      setPhase('error')
      setErrorMsg("Couldn't load that image. Try a different file.")
      return
    }
    sourceCanvasRef.current = oriented
    setSel(null)
    draggingRef.current = null
    // Display the photo at full quality as a JPEG data URL — the <img> renders
    // it crisply at whatever size, unlike the old downscaled-canvas approach.
    setPhotoUrl(oriented.toDataURL('image/jpeg', 0.92))
    setPhase('cropping')
  }

  // Pointer coords relative to the displayed image's top-left (clamped to it).
  function localPoint(e) {
    const rect = imgRef.current.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(e.clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(e.clientY - rect.top, rect.height)),
    }
  }

  function handlePointerDown(e) {
    if (!imgRef.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = localPoint(e)
    draggingRef.current = p
    setSel({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  function handlePointerMove(e) {
    if (!draggingRef.current) return
    const p = localPoint(e)
    const o = draggingRef.current
    setSel({
      x: Math.min(o.x, p.x),
      y: Math.min(o.y, p.y),
      w: Math.abs(p.x - o.x),
      h: Math.abs(p.y - o.y),
    })
  }

  // Releasing the drag automatically reads the selected region — no separate
  // "scan" tap needed. A minimum size guards against accidental tiny drags.
  function handlePointerUp() {
    draggingRef.current = null
    if (sel && sel.w > 16 && sel.h > 16) scanSelection(sel)
  }

  async function scanSelection(region) {
    const img = imgRef.current
    const source = sourceCanvasRef.current
    if (!region || !img || !source || region.w < 16 || region.h < 16) return

    // Map the on-screen selection back to full-resolution source pixels, then
    // crop straight from the original (no contrast/upscale preprocessing —
    // that was mangling clean photos; Tesseract reads the raw crop far better).
    const rect = img.getBoundingClientRect()
    const scaleX = source.width / rect.width
    const scaleY = source.height / rect.height
    const x = Math.round(region.x * scaleX)
    const y = Math.round(region.y * scaleY)
    const w = Math.round(region.w * scaleX)
    const h = Math.round(region.h * scaleY)

    const crop = document.createElement('canvas')
    crop.width = w
    crop.height = h
    crop.getContext('2d').drawImage(source, x, y, w, h, 0, 0, w, h)

    const processed = binarizeForOcr(crop)
    setPhotoUrl(processed.toDataURL('image/png'))  // show the B&W version in review

    const data = await runOcr(processed, 6)
    if (!data) return
    const { text, complete } = cleanOcrText(data.text)
    setOcrText(text || '')
    setIncomplete(!complete)
    setPhase('review')
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-head">
          <span className="modal-title">Scan a label</span>
          <button type="button" className="modal-close" onClick={onClose}>✕</button>
        </div>

        {phase === 'camera' && (
          <div className="camera-wrap" style={{ aspectRatio: videoAspect }}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onLoadedMetadata={(e) => {
                const v = e.target
                if (v.videoWidth && v.videoHeight) setVideoAspect(v.videoWidth / v.videoHeight)
              }}
            />
            <div
              className="camera-guide"
              style={{
                left: `${GUIDE_BOX.left}%`,
                top: `${GUIDE_BOX.top}%`,
                width: `${GUIDE_BOX.width}%`,
                height: `${GUIDE_BOX.height}%`,
              }}
            />
            <span className="camera-hint">Fit the ingredients list in the box</span>
          </div>
        )}

        {phase === 'cropping' && (
          <div className="crop-wrap">
            <div
              className="crop-stage"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            >
              <img ref={imgRef} src={photoUrl} alt="Uploaded label" className="crop-img" draggable={false} />
              {sel && (sel.w > 0 || sel.h > 0) && (
                <div
                  className="crop-sel"
                  style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }}
                />
              )}
            </div>
            <p className="crop-hint">Drag across the ingredients text — it reads automatically</p>
          </div>
        )}

        {phase !== 'camera' && phase !== 'cropping' && phase !== 'review' && (photoUrl ? (
          <div className="scan-photo-wrap">
            <img src={photoUrl} alt="Scanned label" className="scan-photo" />
            {phase === 'reading' && (
              <div className="scan-photo-overlay">
                <span className="scan-caption">reading label… {progress}%</span>
                <div className="scan-progress">
                  <div className="scan-progress-bar" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="scan-box">
            <span className="scan-icon large" />
            <span className="scan-caption">label photo</span>
          </div>
        ))}

        {phase === 'review' && (
          <div className="review-wrap">
            {photoUrl && <img src={photoUrl} alt="Selected region" className="review-thumb" />}
            <p className="review-label">
              {incomplete
                ? `${countIngredients(ocrText)} ingredients found — list may be cut off. Edit below if needed.`
                : `${countIngredients(ocrText)} ingredients found. Fix any errors before detecting.`}
            </p>
            <textarea
              className="review-textarea"
              value={ocrText}
              onChange={(e) => setOcrText(e.target.value)}
              spellCheck={false}
              placeholder="Edit the detected ingredients here…"
            />
          </div>
        )}

        {phase === 'error' && <p className="error modal-error">{errorMsg}</p>}

        {phase === 'idle' && (
          <p className="modal-copy">
            Open your camera and fit the ingredients list in the box, or upload a photo —
            then drag to select just the ingredients text. Everything runs in your browser.
          </p>
        )}

        <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleFile} />

        {phase === 'idle' && (
          <div className="modal-actions-row">
            <button type="button" className="primary modal-cta" onClick={openCamera}>
              Open camera
            </button>
            <button type="button" className="link-btn" onClick={() => fileInputRef.current?.click()}>
              Upload a photo instead
            </button>
            <button type="button" className="link-btn modal-sample-link" onClick={onSample}>
              Or try a sample photo
            </button>
          </div>
        )}

        {phase === 'camera' && (
          <div className="modal-actions-row">
            <button type="button" className="primary modal-cta" onClick={capture}>Capture</button>
            <button type="button" className="link-btn" onClick={resetToIdle}>Cancel</button>
          </div>
        )}

        {phase === 'cropping' && (
          <div className="modal-actions-row">
            <button type="button" className="link-btn" onClick={() => fileInputRef.current?.click()}>
              Upload a different photo
            </button>
            <button type="button" className="link-btn" onClick={resetToIdle}>Cancel</button>
          </div>
        )}

        {phase === 'review' && (
          <div className="modal-actions-row">
            <button
              type="button"
              className="primary modal-cta"
              onClick={() => onExtract(ocrText)}
              disabled={!ocrText.trim()}
            >
              Use this
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setSel(null)
                draggingRef.current = null
                setPhotoUrl(sourceCanvasRef.current?.toDataURL('image/jpeg', 0.92) || null)
                setPhase('cropping')
              }}
            >
              Re-select
            </button>
            <button type="button" className="link-btn" onClick={resetToIdle}>Cancel</button>
          </div>
        )}

        {phase === 'error' && (
          <div className="modal-actions-row">
            <button type="button" className="primary modal-cta" onClick={resetToIdle}>Try again</button>
          </div>
        )}
      </div>
    </div>
  )
}
