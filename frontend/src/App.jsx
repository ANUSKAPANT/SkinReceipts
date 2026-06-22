import { useMemo, useState } from 'react'
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
        <ScanModal onClose={() => setScanning(false)} onSample={() => sampleAndRun(SAMPLES.rich)} />
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

function ScanModal({ onClose, onSample }) {
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
          <span className="scan-icon large" />
          <span className="scan-caption">label photo</span>
        </div>
        <p className="modal-copy">
          Real label scanning is coming soon. For now, try a sample photo to
          see how the check works.
        </p>
        <button type="button" className="primary modal-cta" onClick={onSample}>
          Use a sample photo
        </button>
      </div>
    </div>
  )
}

export default App
