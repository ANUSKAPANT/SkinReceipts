export const GUIDE_BOX = { left: 7, top: 28, width: 86, height: 44 }

// Anchor on the "Ingredients:" label and cut at the first period (INCI lists
// are comma-separated and never contain a literal period, so the first one
// reliably marks the list's end). `complete: false` means no closing period
// was found — the list may have been cut off by the photo edge.
function extractIngredientSection(raw) {
  const afterLabel = raw.match(/[a-z]*gredients?\s*[:.-]?\s*([\s\S]*)/i)
  const body = afterLabel ? afterLabel[1] : raw
  const periodIdx = body.indexOf('.')
  return { text: periodIdx !== -1 ? body.slice(0, periodIdx) : body, complete: periodIdx !== -1 }
}

// Strip trailing/leading noise symbols that OCR leaves at line ends, leave
// comma/newline separators intact for the backend parser.
export function cleanOcrText(raw) {
  const { text, complete } = extractIngredientSection(raw)
  const cleaned = text
    .split('\n')
    .map((line) =>
      line
        .replace(/\s+/g, ' ')
        .replace(/[\s._\-/=:]+$/, '')
        .replace(/^[\s,._\-/=:]+/, '')
        .trim()
    )
    .filter(Boolean)
    .join('\n')
  return { text: cleaned, complete }
}

export function countIngredients(text) {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).length
}

// Rotate a canvas by deg degrees around its centre (white fill).
function rotateCanvas(src, deg) {
  const out = document.createElement('canvas')
  out.width = src.width; out.height = src.height
  const ctx = out.getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.translate(out.width / 2, out.height / 2)
  ctx.rotate(deg * Math.PI / 180)
  ctx.drawImage(src, -src.width / 2, -src.height / 2)
  return out
}

// Row-projection variance: dark-pixel count per row, variance across rows.
// Maximised when text lines are perfectly horizontal.
function rowVariance(canvas) {
  const { width: w, height: h } = canvas
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data
  const sums = new Float32Array(h)
  for (let y = 0; y < h; y++) {
    let s = 0
    for (let x = 0; x < w; x++) s += data[(y * w + x) * 4] < 128 ? 1 : 0
    sums[y] = s
  }
  let mean = 0
  for (const s of sums) mean += s
  mean /= h
  let v = 0
  for (const s of sums) v += (s - mean) ** 2
  return v
}

// Sweep ±maxDeg in 0.5° steps on a 300 px wide proxy to find the rotation
// that maximises row-projection variance (text is horizontal at that angle).
function findSkewAngle(binaryCanvas, maxDeg = 8) {
  const PW = 300
  const ph = Math.max(1, Math.round(binaryCanvas.height * PW / binaryCanvas.width))
  const proxy = document.createElement('canvas')
  proxy.width = PW; proxy.height = ph
  proxy.getContext('2d').drawImage(binaryCanvas, 0, 0, PW, ph)

  let bestAngle = 0, bestVar = rowVariance(proxy)
  for (let deg = -maxDeg; deg <= maxDeg; deg += 0.5) {
    if (deg === 0) continue
    const v = rowVariance(rotateCanvas(proxy, deg))
    if (v > bestVar) { bestVar = v; bestAngle = deg }
  }
  return Math.abs(bestAngle) >= 0.5 ? bestAngle : 0
}

// Upscale → grayscale → cylindrical unwarp → adaptive threshold → rotation correction.
// totalAngleDeg: estimated arc of the visible label on the cylinder (120° fits
// most tube close-ups). Pass 0 to skip unwarping for flat packaging.
export function binarizeForOcr(srcCanvas, totalAngleDeg = 120) {
  const TARGET_LONG = 1200
  const long = Math.max(srcCanvas.width, srcCanvas.height)
  const scale = long < TARGET_LONG ? TARGET_LONG / long : 1
  const w = Math.round(srcCanvas.width * scale)
  const h = Math.round(srcCanvas.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(srcCanvas, 0, 0, w, h)

  // Grayscale
  const raw = ctx.getImageData(0, 0, w, h).data
  const luma = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    luma[i] = 0.299 * raw[i * 4] + 0.587 * raw[i * 4 + 1] + 0.114 * raw[i * 4 + 2]
  }

  // Cylindrical unwarp — arcsin column remap.
  // Each output column x_out maps from source column x_src = sin(θ)/sin(halfAngle),
  // stretching the edge columns (where the cylinder curves away) back to their
  // true width. Skipped when totalAngleDeg === 0.
  let pixels = luma
  if (totalAngleDeg > 0) {
    const halfAngle = (totalAngleDeg * Math.PI / 180) / 2
    const sinHalf = Math.sin(halfAngle)
    const warped = new Float32Array(w * h)
    for (let xo = 0; xo < w; xo++) {
      const theta = ((xo / (w - 1)) - 0.5) * 2 * halfAngle
      const xsf = (Math.sin(theta) / sinHalf + 1) * 0.5 * (w - 1)
      const x0 = Math.max(0, Math.min(w - 2, Math.floor(xsf)))
      const t = xsf - x0
      for (let y = 0; y < h; y++) {
        const base = y * w
        warped[base + xo] = luma[base + x0] * (1 - t) + luma[base + x0 + 1] * t
      }
    }
    pixels = warped
  }

  // Adaptive threshold — integral image local mean, window ~one text-line tall
  const winSize = Math.max(11, Math.min(55, Math.round(h * 0.025)))
  const bias = 12
  const half = Math.floor(winSize / 2)
  const W = w + 1
  const integral = new Float64Array(W * (h + 1))
  for (let y = 1; y <= h; y++) {
    for (let x = 1; x <= w; x++) {
      integral[y * W + x] =
        pixels[(y - 1) * w + (x - 1)] +
        integral[(y - 1) * W + x] +
        integral[y * W + (x - 1)] -
        integral[(y - 1) * W + (x - 1)]
    }
  }

  const out = ctx.createImageData(w, h)
  const od = out.data
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - half), y2 = Math.min(h - 1, y + half)
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half), x2 = Math.min(w - 1, x + half)
      const count = (y2 - y1 + 1) * (x2 - x1 + 1)
      const sum =
        integral[(y2 + 1) * W + (x2 + 1)] -
        integral[y1 * W + (x2 + 1)] -
        integral[(y2 + 1) * W + x1] +
        integral[y1 * W + x1]
      const val = pixels[y * w + x] < sum / count - bias ? 0 : 255
      const idx = (y * w + x) * 4
      od[idx] = od[idx + 1] = od[idx + 2] = val
      od[idx + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)

  // Rotation correction — rotate by the detected skew angle to level the text
  const skew = findSkewAngle(canvas)
  if (skew === 0) return canvas
  return rotateCanvas(canvas, skew)
}

// Decodes the file through the browser's image decoder (EXIF auto-rotation)
// into a canvas so OCR coordinates and crop coordinates always agree.
export async function loadOrientedCanvas(file) {
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = objectUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d').drawImage(img, 0, 0)
    return canvas
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
