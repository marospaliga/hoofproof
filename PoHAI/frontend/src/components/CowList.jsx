import { fmtDate } from "../config.js";
import Name from "./Name.jsx";
import { RatingDiamonds } from "./Rating.jsx";

function CowCard({ cow, onOpen }) {
  const status = `status-${cow.stateKey}`;
  return (
    <div className="cow-card" onClick={() => onOpen(cow)}>
      <div className="face">{cow.image || "🐄"}</div>
      <h3>{cow.name}</h3>
      <div className="sub">
        {cow.breed}
        {cow.age ? ` · ${cow.age}y` : ""}{" "}
        {cow.onChainOwner ? <>· <Name address={cow.onChainOwner} /></> : ""}
      </div>
      <div className="inline mt12" style={{ gap: 6 }}>
        <span className={`badge ${status}`}>{cow.statusName}</span>
      </div>
      <div className="rating-line" title="Rating — earned, never bought">
        <RatingDiamonds rating={cow.rating} />
        <span className="rating-value">{cow.rating}</span>
      </div>
    </div>
  );
}

export default function CowList({ cows, onOpen }) {
  // Guardrails: hide unminted drafts (no token) and collapse any duplicate
  // rows sharing a tokenId, so a double-seed can never render twins.
  const seen = new Set();
  const unique = (cows || []).filter((cow) => {
    if (!cow.tokenId) return false;
    if (seen.has(cow.tokenId)) return false;
    seen.add(cow.tokenId);
    return true;
  });
  if (!unique.length) {
    return <div className="loading">No cows yet. Mint the first one 🐂</div>;
  }
  return (
    <div className="cows-grid">
      {unique.map((cow) => (
        <CowCard key={cow.tokenId} cow={cow} onOpen={onOpen} />
      ))}
    </div>
  );
}