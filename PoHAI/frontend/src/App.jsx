import { useEffect, useRef, useState, useCallback } from "react";
import Wallet from "./components/Wallet.jsx";
import CowList from "./components/CowList.jsx";
import CowDetail from "./components/CowDetail.jsx";
import Trending from "./components/Trending.jsx";
import Course from "./components/Course.jsx";
import PoolGauge from "./components/PoolGauge.jsx";
import MintModal from "./components/MintModal.jsx";
import Docs from "./components/Docs.jsx";
import Events from "./components/Events.jsx";
import Profile from "./components/Profile.jsx";
import { api } from "./lib/api.js";
import {
  applyDeployed,
  connectWallet,
  getContracts,
  enrichCow,
  myReputation,
  friendlyError,
  fmtDuration,
} from "./lib/chain.js";
import { DEFAULT_CONTRACTS } from "./config.js";

export default function App() {
  const [config, setConfig] = useState(DEFAULT_CONTRACTS);
  const [wallet, setWallet] = useState(null);
  const [contracts, setContracts] = useState(null);
  const [rep, setRep] = useState({ score: 0, bonded: 0, voiceLocked: 0, protection: 0 });
  const [cows, setCows] = useState([]);
  const [selectedCid, setSelectedCid] = useState(null);
  const [view, setView] = useState("herd"); // "herd" | "docs" | "events" | "profile" | "trending" | "course"
  const [showMint, setShowMint] = useState(false);
  const [notice, setNotice] = useState(null);
  const [connectError, setConnectError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  // The chain's live deadlines. A beta runs a shortened ruler; showing it
  // stops a tester mistaking a compressed deadline for a broken one.
  const [clock, setClock] = useState(null);
  const noticeTimer = useRef(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;
    api
      .clock()
      .then((c) => {
        if (alive) setClock(c);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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
  }, [selectedCid, view]);

  function openDocs() {
    setSelectedCid(null);
    setView("docs");
  }

  async function onConnect() {
    setConnectError("");
    setConnecting(true);
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
      api.logActivity(w.account, "wallet", "Connected").catch(() => {});
      notify("Wallet connected. Your Stasis: " + r.score);
    } catch (err) {
      setConnectError(friendlyError(err));
    } finally {
      setConnecting(false);
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
    setRep({ score: 0, bonded: 0, voiceLocked: 0, protection: 0 });
    refresh();
  }

  async function handleMinted(cid) {
    setShowMint(false);
    setView("herd");
    await refresh();
    if (cid) setSelectedCid(cid);
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
            setView("herd");
            setSelectedCid(null);
          }}
        >
          Proof of a <span>Hoof</span>
        </a>
        <span className="muted" style={{ fontSize: 13 }}>testnet demo</span>
        {clock && clock.windows && (
          <span
            className={`clock-chip${clock.profile === "beta" ? " beta" : ""}`}
            title={
              clock.profile === "beta"
                ? "Beta clock: one beta day is one production month. The rules are unchanged — only the deadlines are shorter."
                : "Production clock: real deadlines."
            }
          >
            ⏱ {clock.profile === "beta" ? "beta" : "clock"} · lock{" "}
            <b>{fmtDuration(clock.windows.lockPeriod)}</b> · need{" "}
            <b>{fmtDuration(clock.windows.needPeriod)}</b> · cycle{" "}
            <b>{fmtDuration(clock.windows.cyclePeriod)}</b>
          </span>
        )}
        <div className="spacer" />
        <button
          onClick={() => {
            setSelectedCid(null);
            setView("course");
          }}
        >
          🎓 Academy
        </button>
        <button
          onClick={() => {
            setSelectedCid(null);
            setView("events");
          }}
        >
          🎗️ Causes
        </button>
        <button
          onClick={() => {
            setSelectedCid(null);
            setView("trending");
          }}
        >
          🔥 Trending
        </button>
        <button
          onClick={() => {
            setSelectedCid(null);
            if (wallet) setView("profile");
            else notify("Connect a wallet to open your profile.", "error");
          }}
        >
          👤 Profile
        </button>
        <span className="net">{config.network}</span>
        <Wallet
          wallet={wallet}
          error={connectError}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          connecting={connecting}
        />
      </div>

      <div className="container">
        {loading ? (
          <div className="loading">Loading the herd…</div>
        ) : view === "course" ? (
          <Course
            contracts={contracts}
            account={wallet?.account}
            notify={notify}
            onEarned={() => {
              if (contracts && wallet) {
                myReputation(contracts, wallet.account).then(setRep).catch(() => {});
              }
            }}
          />
        ) : view === "events" ? (
          <Events contracts={contracts} account={wallet?.account} notify={notify} />
        ) : view === "trending" ? (
          <Trending cows={cows} onOpen={(cow) => setSelectedCid(cow.cid)} />
        ) : view === "profile" ? (
          <Profile
            address={wallet?.account}
            contracts={contracts}
            account={wallet?.account}
            rep={rep}
            cows={cows}
            notify={notify}
          />
        ) : detailCow ? (
          <CowDetail
            cow={detailCow}
            contracts={contracts}
            account={wallet?.account}
            rep={rep}
            onBack={() => setSelectedCid(null)}
            refresh={refresh}
            onRep={setRep}
            notify={notify}
          />
        ) : view === "docs" ? (
          <Docs onBack={() => setView("herd")} />
        ) : (
          <>
            <PoolGauge />
            {rep.score === 0 && (
              <div className="zero-start">
                You're at <strong>0 Stasis</strong> — that's how everyone starts.{" "}
                <button className="link" onClick={() => setView("course")}>
                  Take the cow-care course →
                </button>{" "}
                to earn your first reputation, then stake, vote and attest.
              </div>
            )}
            <div className="inline" style={{ justifyContent: "space-between", width: "100%" }}>
              <h2 style={{ margin: 0 }}>The herd</h2>
              <div className="row" style={{ gap: 8 }}>
                <button onClick={openDocs}>📄 Whitepaper &amp; references</button>
                <button className="primary" onClick={() => setShowMint(true)}>
                  Mint a cow
                </button>
              </div>
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