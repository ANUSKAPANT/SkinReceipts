import { SAMPLES } from '../lib/samples'

export default function EntryView({ input, setInput, onRun, onScan, canRun, loading, error, onSample }) {
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
