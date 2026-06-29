import { useMemo } from 'react'
import { comedoStatus, faBadge, fungalStatus, fungalVerdict, poreBadge, poreVerdict } from '../lib/receipt'

export default function Receipt({ response, meta, bars, onReset }) {
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
                <span
                  className="row-name"
                  title={r.status === 'fuzzy_match' ? `read as "${r.input}"` : undefined}
                >
                  {r.status === 'fuzzy_match' ? r.inci_name : r.input}
                  {r.status === 'fuzzy_match' && <span className="row-corrected">~</span>}
                </span>
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
