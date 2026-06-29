export function buildMeta() {
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return {
    order: '#' + (Math.floor(Math.random() * 9000) + 1000),
    date: `${p(now.getMonth() + 1)}/${p(now.getDate())}/${now.getFullYear()}`,
    time: `${p(now.getHours())}:${p(now.getMinutes())}`,
  }
}

// decorative barcode pattern under the receipt, same generator as the prototype
export function buildBars() {
  return Array.from({ length: 36 }, (_, i) => ((i * 7 + 3) % 4) + 1)
}

export function poreBadge(row) {
  if (row.status === 'unknown') return { tier: 'safe', t: '✓' }
  if (row.status === 'keyword_match') return { tier: 'neutral', t: '—' }
  return row.pore_clogging ? { tier: 'danger', t: '✕' } : { tier: 'safe', t: '✓' }
}

export function faBadge(row) {
  if (row.status === 'unknown') return { tier: 'safe', t: '✓' }
  const risk = row.fungal_acne_risk
  if (!risk) return { tier: 'safe', t: '✓' }
  if (risk === 'high') return { tier: 'danger', t: 'High Risk' }
  return { tier: 'caution', t: risk === 'medium' ? 'Medium Risk' : 'Low Risk' }
}

export function poreVerdict(summary) {
  const count = summary.poreCloggingCount
  if (count === 0) return { tier: 'safe', score: '0' }
  if (count <= 2) return { tier: 'caution', score: String(count) }
  return { tier: 'danger', score: String(count) }
}

export function fungalVerdict(summary) {
  const count = summary.fungalAcneCount
  if (count === 0) return { tier: 'safe', score: '0' }
  const tier = summary.worstFungalAcneRisk === 'high' ? 'danger' : 'caution'
  return { tier, score: String(count) }
}

export function comedoStatus(summary) {
  if (summary.poreCloggingCount === 0) {
    return { tier: 'safe', text: 'Hooray, this is non-comedogenic!' }
  }
  return { tier: summary.poreCloggingCount > 2 ? 'danger' : 'caution', text: 'This product is comedogenic.' }
}

export function fungalStatus(summary) {
  if (summary.fungalAcneCount === 0) {
    return { tier: 'safe', text: 'This is fungal-acne safe.' }
  }
  return {
    tier: summary.worstFungalAcneRisk === 'high' ? 'danger' : 'caution',
    text: 'This product is not fungal-acne safe.',
  }
}
