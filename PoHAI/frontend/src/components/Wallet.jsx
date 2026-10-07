import Name from "./Name.jsx";

export default function Wallet({ wallet, error, onConnect, onDisconnect }) {
  return (
    <div className="inline">
      {wallet ? (
        <>
          <Name address={wallet.account} className="net" />
          <span className="muted">
            {" "}
            <span className="net">chain {wallet.chainId}</span>
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