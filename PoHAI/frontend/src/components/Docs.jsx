// Simple viewer for the whitepaper (PDF in frontend/public/whitepaper.pdf).
// The references the project cites (videos, books) live inside the document.
export default function Docs({ onBack }) {
  return (
    <div>
      <button onClick={onBack}>← Herd</button>
      <div className="mt12 panel">
        <div className="inline" style={{ justifyContent: "space-between", width: "100%" }}>
          <h2 style={{ margin: 0 }}>The whitepaper &amp; references</h2>
          <a
            href="/whitepaper.pdf"
            download="ProofOfAHoof.pdf"
            style={{
              border: "1px solid var(--accent)",
              color: "var(--accent)",
              padding: "6px 12px",
              borderRadius: 8,
              textDecoration: "none",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            ⬇ Download PDF
          </a>
        </div>
        <p className="muted" style={{ maxWidth: 720 }}>
          The full argument behind <b>Proof of a Hoof</b> — the references the
          text cites (videos and books) are inside the document. Use the
          browser's in-page viewer below or download it.
        </p>
        <iframe
          src="/whitepaper.pdf"
          title="Proof of a Hoof — whitepaper"
          style={{
            width: "100%",
            height: "82vh",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "#fff",
          }}
        />
      </div>
    </div>
  );
}