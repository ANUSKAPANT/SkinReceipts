// Fixed guide box (percentages of the live camera frame) the user lines the
// ingredients list up with. Capturing crops to exactly this region, so OCR
// never even sees the marketing copy / caution text around it.
export const GUIDE_BOX = { left: 7, top: 28, width: 86, height: 44 }

// Packaging photos usually have other copy (marketing text, directions,
// caution notices) above and below the ingredients list itself. Anchor on
// the "Ingredients:" label wherever it falls in the OCR'd text and cut at
// the very first period after it — INCI names are comma-separated and never
// contain a literal period, so the first one reliably marks the list's end
// (note: it doesn't need to be followed by a line break — OCR sometimes
// runs the next label, e.g. "Caution:", onto the same line).
// `complete: false` means no closing period was found — the list may have
// run off the edge of the photo (tilted/cropped shots) rather than OCR
// genuinely finishing it, so callers can warn instead of presenting a
// partial list as if it were the whole thing.
function extractIngredientSection(raw) {
  // Tolerate OCR mangling the leading letters of "Ingredients" (a missing "I"
  // is common) by anchoring on the stable "gredient" core instead of the whole
  // word. Strips an optional ":" / "." / "-" separator after the label too.
  const afterLabel = raw.match(/[a-z]*gredients?\s*[:.-]?\s*([\s\S]*)/i)
  const body = afterLabel ? afterLabel[1] : raw
  const periodIdx = body.indexOf('.')
  return { text: periodIdx !== -1 ? body.slice(0, periodIdx) : body, complete: periodIdx !== -1 }
}

// Tidies each line after extraction. Leaves comma/newline separators alone —
// the backend parser already splits on either. Beyond whitespace, it strips
// the stray symbols the warped tube-edge tends to leave dangling at line ends
// (e.g. "Glyceryl Stearate _", "Arginine HCl =-") without touching the comma
// delimiters or anything mid-line.
export function cleanOcrText(raw) {
  const { text, complete } = extractIngredientSection(raw)
  const cleaned = text
    .split('\n')
    .map((line) =>
      line
        .replace(/\s+/g, ' ')
        .replace(/[\s._\-/=:]+$/, '') // drop trailing edge noise, keep a real trailing comma
        .replace(/^[\s,._\-/=:]+/, '') // drop leading junk before the first name
        .trim()
    )
    .filter(Boolean)
    .join('\n')
  return { text: cleaned, complete }
}

export function countIngredients(text) {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).length
}

// Tesseract's word-level output is nested block > paragraph > line > word,
// but on busy labels (banners, bullets, headers) the blocks themselves don't
// always come back in top-to-bottom visual order. Sort lines by their actual
// vertical position first so the anchor/period search below follows real
// reading order instead of Tesseract's internal block order.
export function flattenWords(blocks) {
  const lines = []
  for (const block of blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) lines.push(line)
    }
  }
  lines.sort((a, b) => a.bbox.y0 - b.bbox.y0)
  return lines.flatMap((line) => line.words || [])
}

// For an uploaded gallery photo there's no live framing, so instead we OCR
// the whole image first and find the pixel region (block > word bboxes)
// spanning from "Ingredients:" to the list's first closing period — then
// crop the preview down to just that, same end result as the camera path.
export function findIngredientBox(words, imgWidth, imgHeight) {
  const startIdx = words.findIndex((w) => /ingredient/i.test(w.text))
  if (startIdx === -1) return null

  let endIdx = words.length - 1
  for (let i = startIdx; i < words.length; i++) {
    if (words[i].text.includes('.')) {
      endIdx = i
      break
    }
  }

  const box = words.slice(startIdx, endIdx + 1).reduce(
    (b, w) => ({
      x0: Math.min(b.x0, w.bbox.x0),
      y0: Math.min(b.y0, w.bbox.y0),
      x1: Math.max(b.x1, w.bbox.x1),
      y1: Math.max(b.y1, w.bbox.y1),
    }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  )

  // Pad generously — a slightly-off word box shouldn't slice through real
  // text at the edges. Better to keep a little surrounding label than to
  // lose part of the ingredient list.
  const padX = (box.x1 - box.x0) * 0.05
  const padY = (box.y1 - box.y0) * 0.12
  return {
    x0: Math.max(0, box.x0 - padX),
    y0: Math.max(0, box.y0 - padY),
    x1: Math.min(imgWidth, box.x1 + padX),
    y1: Math.min(imgHeight, box.y1 + padY),
  }
}

// Grayscale + contrast boost to improve Tesseract accuracy on product photos.
// Upscales small images (Tesseract degrades below ~150 dpi equivalent),
// converts to grayscale, then stretches contrast toward black/white.
export function preprocessForOcr(srcCanvas) {
  const TARGET = 1600
  const long = Math.max(srcCanvas.width, srcCanvas.height)
  const scale = long < TARGET ? TARGET / long : 1

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(srcCanvas.width * scale)
  canvas.height = Math.round(srcCanvas.height * scale)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(srcCanvas, 0, 0, canvas.width, canvas.height)

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    // Push midtones toward their nearest extreme — aggressive enough to
    // separate text from background without losing thin strokes.
    const c = gray < 128
      ? Math.max(0, gray * 0.55)
      : Math.min(255, 255 - (255 - gray) * 0.55)
    d[i] = d[i + 1] = d[i + 2] = c
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

// Decodes the file once through the browser's own image decoder (which
// reliably auto-rotates per EXIF) into a canvas. Tesseract does its own
// EXIF detection via a regex byte-scan that can disagree with the browser
// on real phone photos — feeding it this canvas instead of the raw file
// means OCR's word coordinates and our crop always share one coordinate
// space, whichever way the photo was actually rotated.
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

export function cropCanvasToBox(sourceCanvas, box) {
  if (!box) return null
  const canvas = document.createElement('canvas')
  canvas.width = box.x1 - box.x0
  canvas.height = box.y1 - box.y0
  canvas
    .getContext('2d')
    .drawImage(sourceCanvas, box.x0, box.y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.92)
}
