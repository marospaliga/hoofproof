import { fmtDate } from "../config.js";
import Name from "./Name.jsx";

function CowCard({ cow, onOpen }) {
  const status = `status-${cow.statusName}`;
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
      <div className="row mt12" style={{ alignItems: "center" }}>
        <div className="stat" style={{ margin: 0 }}>
          <div className="k">Rating</div>
          <div className="v">{cow.rating}</div>
        </div>
        <div className="stat" style={{ margin: 0 }}>
          <div className="k">Backing</div>
          <div className="v">{cow.backing}</div>
        </div>
      </div>
    </div>
  );
}

export default function CowList({ cows, onOpen }) {
  if (!cows.length) {
    return <div className="loading">No cows yet. Mint the first one 🐂</div>;
  }
  return (
    <div className="cows-grid">
      {cows.map((cow) => (
        <CowCard key={cow.cid} cow={cow} onOpen={onOpen} />
      ))}
    </div>
  );
}