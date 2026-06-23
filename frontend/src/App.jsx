import { useMemo, useRef, useState } from 'react'
import { createWorker, PSM } from 'tesseract.js'
import './App.css'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const SAMPLES = {
  gentle:
    'Aqua, Glycerin, Cetearyl Alcohol, Caprylic/Capric Triglyceride, Niacinamide, Ceramide NP, Hyaluronic Acid, Dimethicone, Panthenol, Squalane, Cholesterol, Phytosphingosine, Tocopherol, Phenoxyethanol',
  rich:
    'Cocos Nucifera (Coconut) Oil, Isopropyl Myristate, Theobroma Cacao (Cocoa) Seed Butter, Shea Butter, Beeswax, Lecithin, Tocopheryl Acetate, Stearic Acid, Glyceryl Stearate, Polysorbate 80, Fragrance',
}

function buildMeta() {
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return {
    order: '#' + (Math.floor(Math.random() * 9000) + 1000),
    date: `${p(now.getMonth() + 1)}/${p(now.getDate())}/${now.getFullYear()}`,
    time: `${p(now.getHours())}:${p(now.getMinutes())}`,
  }
}

// decorative barcode pattern under the receipt, same generator as the prototype
function buildBars() {
  return Array.from({ length: 36 }, (_, i) => ((i * 7 + 3) % 4) + 1)
}

// Packaging photos usually have other copy (marketing text, directions)
// above and below the ingredients list itself. Anchor on the "Ingredients:"
// label wherever it falls in the OCR'd text and cut at the list's closing
// period, dropping anything before or after.
function extractIngredientSection(raw) {
  const afterLabel = raw.match(/ingredients\s*[:-]?\s*([\s\S]*)/i)
  let body = afterLabel ? afterLabel[1] : raw
  const periodIdx = body.search(/\.\s*(?:\n|$)/)
  if (periodIdx !== -1) body = body.slice(0, periodIdx)
  return body
}

// Tidies whitespace per line after extraction. Leaves comma/newline
// separators alone — the backend parser already splits on either.
function cleanOcrText(raw) {
  return extractIngredientSection(raw)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

// Upscales and boosts contrast before handing the image to Tesseract.
// Cosmetic labels tend to be small, low-contrast, and printed on a curved
// surface, which is exactly the case Tesseract handles worst out of the box.
async function preprocessImage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })

  const img = await new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = reject
    el.src = dataUrl
  })

  const scale = img.width < 1600 ? 1600 / img.width : 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.width * scale)
  canvas.height = Math.round(img.height * scale)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const { data } = imageData
  const contrast = 1.6
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    const boosted = Math.min(255, Math.max(0, (gray - 128) * contrast + 128))
    data[i] = data[i + 1] = data[i + 2] = boosted
  }
  ctx.putImageData(imageData, 0, 0)

  return canvas
}

function poreBadge(row) {
  if (row.status === 'unknown') return { tier: 'safe', t: '✓' }
  if (row.status === 'keyword_match') return { tier: 'neutral', t: '—' }
  return row.pore_clogging ? { tier: 'danger', t: '✕' } : { tier: 'safe', t: '✓' }
}

function faBadge(row) {
  if (row.status === 'unknown') return { tier: 'safe', t: '✓' }
  const risk = row.fungal_acne_risk
  if (!risk) return { tier: 'safe', t: '✓' }
  if (risk === 'high') return { tier: 'danger', t: 'High Risk' }
  return { tier: 'caution', t: risk === 'medium' ? 'Medium Risk' : 'Low Risk' }
}

function poreVerdict(summary) {
  const count = summary.poreCloggingCount
  if (count === 0) return { tier: 'safe', score: '0' }
  if (count <= 2) return { tier: 'caution', score: String(count) }
  return { tier: 'danger', score: String(count) }
}

function fungalVerdict(summary) {
  const count = summary.fungalAcneCount
  if (count === 0) return { tier: 'safe', score: '0' }
  const tier = summary.worstFungalAcneRisk === 'high' ? 'danger' : 'caution'
  return { tier, score: String(count) }
}

function comedoStatus(summary) {
  if (summary.poreCloggingCount === 0) {
    return { tier: 'safe', text: 'Hooray, this is non-comedogenic!' }
  }
  return { tier: summary.poreCloggingCount > 2 ? 'danger' : 'caution', text: 'This product is comedogenic.' }
}

function fungalStatus(summary) {
  if (summary.fungalAcneCount === 0) {
    return { tier: 'safe', text: 'This is fungal-acne safe.' }
  }
  return {
    tier: summary.worstFungalAcneRisk === 'high' ? 'danger' : 'caution',
    text: 'This product is not fungal-acne safe.',
  }
}

function App() {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const [scanning, setScanning] = useState(false)

  async function runCheck(text) {
    const value = (text ?? input).trim()
    if (!value || loading) return

    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: value }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Something went wrong')
      setReceipt({ response: body, meta: buildMeta(), bars: buildBars() })
      setScanning(false)
    } catch (err) {
      setError(err.message)
      setReceipt(null)
    } finally {
      setLoading(false)
    }
  }

  function sampleAndRun(text) {
    setInput(text)
    runCheck(text)
  }

  const canRun = input.trim().length > 0

  return (
    <div id="checker">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <span className="brand-name">Skin Receipts</span>
        </div>
        <span className="tagline">ingredient checkout</span>
      </header>

      {!receipt && (
        <EntryView
          input={input}
          setInput={setInput}
          onRun={() => runCheck()}
          onScan={() => setScanning(true)}
          canRun={canRun}
          loading={loading}
          error={error}
          onSample={setInput}
        />
      )}

      {receipt && (
        <Receipt
          response={receipt.response}
          meta={receipt.meta}
          bars={receipt.bars}
          onReset={() => setReceipt(null)}
        />
      )}

      {scanning && (
        <ScanModal
          onClose={() => setScanning(false)}
          onSample={() => sampleAndRun(SAMPLES.rich)}
          onExtract={(text) => {
            setInput(text)
            setScanning(false)
          }}
        />
      )}
    </div>
  )
}

function EntryView({ input, setInput, onRun, onScan, canRun, loading, error, onSample }) {
  return (
    <div className="entry">
      <h1>
        Know what&apos;s really
        <br />
        in your skincare.
      </h1>
      <p className="lede">
        Paste an ingredient list. We check every line for pore-cloggers and
        fungal-acne triggers — then print it back as a receipt.
      </p>

      <div className="input-card">
        <div className="input-card-head">
          <span className="label">Ingredients</span>
          <button type="button" className="link-btn" onClick={() => setInput('')}>
            Clear
          </button>
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Aqua, Glycerin, Niacinamide, Cetearyl Alcohol, Coconut Oil…"
        />
      </div>

      <div className="samples">
        <span>Try:</span>
        <button type="button" onClick={() => onSample(SAMPLES.gentle)}>
          Gentle moisturizer
        </button>
        <button type="button" onClick={() => onSample(SAMPLES.rich)}>
          Rich body butter
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button type="button" className="primary" onClick={onRun} disabled={!canRun || loading}>
          {loading ? 'Checking…' : 'Run the check  →'}
        </button>
        <button type="button" className="secondary" onClick={onScan}>
          <span className="scan-icon" />
          Scan a label
        </button>
      </div>

      <div className="features">
        <div>
          <div className="feature-title">Pore check</div>
          <div className="feature-sub">Flags ingredients on the known pore-clogging list.</div>
        </div>
        <div>
          <div className="feature-title">Fungal-acne check</div>
          <div className="feature-sub">Flags esters, oils &amp; fatty acids that feed malassezia.</div>
        </div>
      </div>
    </div>
  )
}

function Receipt({ response, meta, bars, onReset }) {
  const { results, summary } = response
  const recognized = summary.total - summary.unknownCount
  const pore = poreVerdict(summary)
  const fungal = fungalVerdict(summary)

  const rows = useMemo(() => {
    const flagged = (r) => r.pore_clogging || r.fungal_acne_risk === 'high'
    return [...results].sort((a, b) => (flagged(b) ? 1 : 0) - (flagged(a) ? 1 : 0))
  }, [results])

  const comedo = comedoStatus(summary)
  const fungalSafe = fungalStatus(summary)

  return (
    <div className="receipt-wrap">
      <div className="receipt">
        <div className="receipt-body">
          <div className="receipt-head">
            <div className="receipt-title">SKIN RECEIPTS</div>
            <div className="receipt-stamp">★ DERMAL CHECKOUT ★</div>
          </div>

          <div className="status-banners">
            <div className={`status-banner tier-${comedo.tier}`}>{comedo.text}</div>
            <div className={`status-banner tier-${fungalSafe.tier}`}>{fungalSafe.text}</div>
          </div>

          <Divider />

          <div className="row-head">
            <span className="col-name">Ingredient</span>
            <span className="col-badge col-pore">Non-comedogenic</span>
            <span className="col-badge col-fa">FA Safe</span>
          </div>

          {rows.map((r, i) => {
            const pb = poreBadge(r)
            const fb = faBadge(r)
            return (
              <div className="row" key={`${r.input}-${i}`}>
                <span className="row-name">{r.input}</span>
                <span className="row-fill" />
                <span className={`badge badge-pore tier-${pb.tier}`}>{pb.t}</span>
                <span className={`badge badge-fa tier-${fb.tier}`}>{fb.t}</span>
              </div>
            )
          })}

          <Divider mt={16} mb={14} />

          <div className="verdicts">
            <VerdictCard kicker="Pore-Clogging" v={pore} foot="FLAGGED" />
            <VerdictCard kicker="Fungal Acne" v={fungal} foot="FLAGGED" />
          </div>

          <Divider />

          <div className="receipt-footnote">
            {recognized} of {summary.total} ingredients recognised
            <br />
            unrecognised lines default to safe
          </div>

          <div className="barcode">
            {bars.map((b, i) => (
              <div key={i} className="bar" style={{ width: b }} />
            ))}
          </div>
          <div className="barcode-label">
            * {meta.order} {meta.date} *
          </div>
          <div className="thank-you">THANK YOU FOR GLOWING</div>
        </div>
        <div className="tear" />
      </div>

      <button type="button" className="primary check-another" onClick={onReset}>
        Check another
      </button>
    </div>
  )
}

function VerdictCard({ kicker, v, foot }) {
  return (
    <div className={`verdict-card tier-${v.tier}`}>
      <div className="kicker">{kicker}</div>
      <div className="verdict-count">{v.score}</div>
      <div className="verdict-foot">{foot}</div>
    </div>
  )
}

function Divider({ mt, mb }) {
  const style = {}
  if (mt != null) style.marginTop = mt
  if (mb != null) style.marginBottom = mb
  return <div className="divider" style={style} />
}

function ScanModal({ onClose, onSample, onExtract }) {
  const fileInputRef = useRef(null)
  const [phase, setPhase] = useState('idle') // idle | reading | error
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState(null)
  const reading = phase === 'reading'

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setPhase('reading')
    setProgress(0)
    setErrorMsg(null)

    try {
      const preprocessed = await preprocessImage(file)
      const worker = await createWorker('eng', undefined, {
        logger: (m) => {
          if (m.status === 'recognizing text') setProgress(Math.round(m.progress * 100))
        },
      })
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK })
      const { data } = await worker.recognize(preprocessed)
      await worker.terminate()
      const text = cleanOcrText(data.text)
      if (!text) {
        setPhase('error')
        setErrorMsg("Couldn't find readable text in that photo — try a clearer, well-lit shot of the ingredients list.")
        return
      }
      onExtract(text)
    } catch {
      setPhase('error')
      setErrorMsg('Something went wrong reading that photo. Try again.')
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-head">
          <span className="modal-title">Scan a label</span>
          <button type="button" className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="scan-box">
          {reading ? (
            <>
              <span className="scan-caption">reading label… {progress}%</span>
              <div className="scan-progress">
                <div className="scan-progress-bar" style={{ width: `${progress}%` }} />
              </div>
            </>
          ) : (
            <>
              <span className="scan-icon large" />
              <span className="scan-caption">label photo</span>
            </>
          )}
        </div>

        {phase === 'error' && <p className="error modal-error">{errorMsg}</p>}

        <p className="modal-copy">
          Take or upload a photo of the ingredients list — it's read entirely
          in your browser; nothing gets uploaded anywhere.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={handleFile}
        />

        <button
          type="button"
          className="primary modal-cta"
          onClick={() => fileInputRef.current?.click()}
          disabled={reading}
        >
          {reading ? 'Reading…' : 'Take or upload a photo'}
        </button>

        <button type="button" className="link-btn modal-sample-link" onClick={onSample} disabled={reading}>
          Or try a sample photo instead
        </button>
      </div>
    </div>
  )
}

export default App
