import { useEffect, useRef, useState, useCallback } from "react";
import Wallet from "./components/Wallet.jsx";
import CowList from "./components/CowList.jsx";
import CowDetail from "./components/CowDetail.jsx";
import MintModal from "./components/MintModal.jsx";
import { api } from "./lib/api.js";
import {
  applyDeployed,
  connectWallet,
  getContracts,
  enrichCow,
  myReputation,
  friendlyError,
} from "./lib/chain.js";
import { DEFAULT_CONTRACTS } from "./config.js";

export default function App() {
  const [config, setConfig] = useState(DEFAULT_CONTRACTS);
  const [wallet, setWallet] = useState(null);
  const [contracts, setContracts] = useState(null);
  const [rep, setRep] = useState({ score: 0, bonded: 0 });
  const [cows, setCows] = useState([]);
  const [selectedCid, setSelectedCid] = useState(null);
  const [showMint, setShowMint] = useState(false);
  const [notice, setNotice] = useState(null);
  const [connectError, setConnectError] = useState("");
  const [loading, setLoading] = useState(true);
  const noticeTimer = useRef(null);
  const inFlight = useRef(false);

  const notify = useCallback((message, kind = "success") => {
    setNotice({ message, kind });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  }, []);

  // Fetch the deployed addresses (server knows them once deploy runs).
  useEffect(() => {
    api
      .config()
      .then((cfg) => setConfig(applyDeployed(cfg)))
      .catch(() => {});
  }, []);

  // Read the off-chain cow list, merging on-chain stats when connected.
  // Navigation state is a cid, not the cow object — refresh() only updates the
  // list, so it never fights a "back" click.
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const records = await api.listCows();
      let enriched = records;
      if (contracts) {
        enriched = await Promise.all(
          records.map(async (r) => {
            try {
              return r.tokenId ? await enrichCow(r, contracts) : r;
            } catch {
              return { ...r, statusName: "—", status: -1 };
            }
          })
        );
      }
      setCows(
        enriched.map((c) => ({
          ...c,
          rating: c.rating ?? "—",
          backing: c.backing ?? "—",
          statusName: c.statusName || "no chain",
        }))
      );
    } catch (err) {
      notify("Could not reach the agorá server (npm run server).", "error");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [contracts, notify]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The opened cow is *derived* from the list, so it stays live without any
  // feedback loop.
  const detailCow = selectedCid ? cows.find((c) => c.cid === selectedCid) : null;

  // Jump back to the top when navigating between herd and detail.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [selectedCid]);

  async function onConnect() {
    setConnectError("");
    try {
      const w = await connectWallet(config.network);
      const c = getContracts(w.signer, config);
      const [r] = await Promise.all([
        myReputation(c, w.account),
        masterRefresh(c, w.account),
      ]);
      setWallet(w);
      setContracts(c);
      setRep(r);
      notify("Wallet connected. Your Stasis: " + r.score);
    } catch (err) {
      setConnectError(friendlyError(err));
    }
  }

  // Re-enrich the list using an explicit contract set (used before state lands).
  async function masterRefresh(c, account) {
    const records = await api.listCows();
    const enriched = await Promise.all(
      records.map(async (r) => {
        try {
          return r.tokenId ? await enrichCow(r, c) : r;
        } catch {
          return { ...r, statusName: "—", status: -1 };
        }
      })
    );
    const stats = await myReputation(c, account);
    setCows(enriched);
    setRep(stats);
    setLoading(false);
    return stats;
  }

  function onDisconnect() {
    setWallet(null);
    setContracts(null);
    setRep({ score: 0, bonded: 0 });
    refresh();
  }

  async function handleMinted() {
    setShowMint(false);
    await refresh();
    if (contracts && wallet) {
      setRep(await myReputation(contracts, wallet.account));
    }
  }

  return (
    <div>
      <div className="topbar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setSelectedCid(null);
          }}
        >
          Proof of a <span>Hoof</span>
        </a>
        <span className="muted" style={{ fontSize: 13 }}>testnet demo</span>
        <div className="spacer" />
        <span className="net">{config.network}</span>
        <Wallet
          wallet={wallet}
          error={connectError}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
      </div>

      <div className="container">
        {loading ? (
          <div className="loading">Loading the herd…</div>
        ) : detailCow ? (
          <CowDetail
            cow={detailCow}
            contracts={contracts}
            account={wallet?.account}
            rep={rep}
            onBack={() => setSelectedCid(null)}
            refresh={refresh}
            notify={notify}
          />
        ) : (
          <>
            <div className="inline" style={{ justifyContent: "space-between", width: "100%" }}>
              <h2 style={{ margin: 0 }}>The herd</h2>
              <button className="primary" onClick={() => setShowMint(true)}>
                Mint a cow
              </button>
            </div>
            <p className="muted" style={{ maxWidth: 640 }}>
              Cows start <b>Inert</b>. Raters stake their reputation to back one,
              and once enough independent raters commit, it becomes{" "}
              <b>Active</b> and joins the conversation below.
            </p>
            <CowList cows={cows} onOpen={(cow) => setSelectedCid(cow.cid)} />
          </>
        )}
      </div>

      {showMint && (
        <MintModal
          contracts={contracts}
          account={wallet?.account}
          onClose={() => setShowMint(false)}
          onMinted={handleMinted}
          notify={notify}
        />
      )}

      {notice && (
        <div className={`notice ${notice.kind === "error" ? "error" : ""}`}>
          <button className="close" onClick={() => setNotice(null)}>✕</button>
          {notice.message}
        </div>
      )}
    </div>
  );
}