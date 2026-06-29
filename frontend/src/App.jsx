import { useState } from 'react'
import EntryView from './components/EntryView'
import Receipt from './components/Receipt'
import ScanModal from './components/ScanModal'
import { buildBars, buildMeta } from './lib/receipt'
import { SAMPLES } from './lib/samples'
import './App.css'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

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

export default App
