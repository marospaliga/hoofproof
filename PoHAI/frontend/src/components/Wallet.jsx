import { shortAddr } from "../config.js";

export default function Wallet({ wallet, error, onConnect, onDisconnect }) {
  return (
    <div className="inline">
      {wallet ? (
        <>
          <span className="net">
            {shortAddr(wallet.account)}{" "}
            <span className="muted">· chain {wallet.chainId}</span>
          </span>
          <button onClick={onDisconnect}>Disconnect</button>
        </>
      ) : (
        <button className="primary" onClick={onConnect} disabled={!!error}>
          Connect wallet
        </button>
      )}
      {error && <span className="muted" style={{ maxWidth: 260, fontSize: 12 }}>{error}</span>}
    </div>
  );
}