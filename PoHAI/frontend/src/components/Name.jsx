import { useEffect, useState } from "react";
import { shortAddr } from "../config.js";
import { api } from "../lib/api.js";

// Resolved profile names, memoised across the whole app session.
const nameCache = new Map();

export function profileName(address) {
  if (!address) return null;
  return nameCache.get(address.toLowerCase()) || null;
}

export default function Name({ address, className, style }) {
  const [name, setName] = useState(() => profileName(address));

  useEffect(() => {
    if (!address) {
      setName(null);
      return;
    }
    const key = address.toLowerCase();
    if (nameCache.has(key)) {
      setName(nameCache.get(key));
      return;
    }
    let alive = true;
    api
      .getProfile(key)
      .then((p) => {
        if (!alive) return;
        nameCache.set(key, p.name);
        setName(p.name);
      })
      .catch(() => {
        if (alive) setName(null);
      });
    return () => {
      alive = false;
    };
  }, [address]);

  return (
    <span className={className} style={style}>
      {name || shortAddr(address)}
    </span>
  );
}