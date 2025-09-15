// server.js — FarGuard Attester (Neynar + Base + RevokeHelper)
// Node: ESM
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import { ethers } from "ethers";

dotenv.config();

/* ---------- required envs ---------- */
const {
  ATTESTER_PK,
  VERIFYING_CONTRACT,
  REVOKE_HELPER_ADDRESS,
  BASE_RPC,
  CHAIN_ID: CHAIN_ID_ENV,
  NEYNAR_API_KEY,
  PORT: PORT_ENV
} = process.env;

const PORT = Number(PORT_ENV || 8080);
const CHAIN_ID = Number(CHAIN_ID_ENV || 8453);

if (!ATTESTER_PK || !VERIFYING_CONTRACT || !REVOKE_HELPER_ADDRESS || !BASE_RPC || !NEYNAR_API_KEY) {
  console.error("❌ Missing required env vars. Set ATTESTER_PK, VERIFYING_CONTRACT, REVOKE_HELPER_ADDRESS, BASE_RPC, NEYNAR_API_KEY");
  process.exit(1);
}

/* ---------- providers & signer ---------- */
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, { name: "base", chainId: CHAIN_ID });
const attesterWallet = new ethers.Wallet(ATTESTER_PK); // signing only; ok without provider

console.log("✅ Attester address:", attesterWallet.address);
console.log("✅ Verifying contract:", VERIFYING_CONTRACT);
console.log("✅ RevokeHelper address:", REVOKE_HELPER_ADDRESS);
console.log("✅ Base RPC:", BASE_RPC);

/* ---------- constants ---------- */
const REVOKE_EVENT_TOPIC = ethers.id("Revoked(address,address,address)");

const NAME = "RevokeAndClaim";
const VERSION = "1";
const ATTEST_TYPES = {
  Attestation: [
    { name: "wallet", type: "address" },
    { name: "fid", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "token", type: "address" },
    { name: "spender", type: "address" },
  ],
};
function buildDomain() {
  return {
    name: NAME,
    version: VERSION,
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
  };
}

/* ---------- express app ---------- */
const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(cors());
app.use(helmet());
app.set("trust proxy", 1);
app.use(rateLimit({ windowMs: 60_000, max: 60, message: { error: "Too many requests" } }));

/* ---------- helpers ---------- */

/**
 * Query Neynar bulk-by-address endpoint to find Farcaster user for given wallet.
 * Returns user object or null.
 */
async function getFarcasterUser(wallet) {
  try {
    const url = `https://api.neynar.com/v2/farcaster/user/bulk-by-address/?addresses=${encodeURIComponent(wallet)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": NEYNAR_API_KEY,
        "accept": "application/json",
        "x-neynar-experimental": "false",
      },
      timeout: 15000,
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      console.warn("Neynar returned non-json:", text.slice(0, 200));
      return null;
    }

    // Neynar returns `users: []` on success; be defensive:
    if (Array.isArray(data.users) && data.users.length > 0) {
      return data.users[0];
    }
    // fallback shapes (some SDK responses) — defensive:
    if (data.result && data.result.user) return data.result.user;
    if (data.users && Array.isArray(data.users) && data.users.length === 0) return null;

    return null;
  } catch (err) {
    console.error("getFarcasterUser error:", err?.message || err);
    throw new Error("neynar lookup failed");
  }
}

/**
 * Check if RevokeHelper emitted Revoked(wallet, token, spender) on Base.
 * Returns boolean.
 */
async function hasRevokedOnBase(wallet, token, spender) {
  try {
    const topics = [
      REVOKE_EVENT_TOPIC,
      ethers.hexZeroPad(ethers.getAddress(wallet), 32),
      ethers.hexZeroPad(ethers.getAddress(token), 32),
      ethers.hexZeroPad(ethers.getAddress(spender), 32),
    ];

    const filter = {
      address: REVOKE_HELPER_ADDRESS,
      topics,
      fromBlock: 0,
      toBlock: "latest",
    };

    const logs = await baseProvider.getLogs(filter);
    return Array.isArray(logs) && logs.length > 0;
  } catch (err) {
    console.error("hasRevokedOnBase error:", err?.message || err);
    throw new Error("log lookup failed");
  }
}

/* ---------- endpoints ---------- */

// Health
app.get("/health", (req, res) => {
  return res.json({ ok: true, attester: attesterWallet.address });
});

// Attest
app.post("/attest", async (req, res) => {
  try {
    const { wallet, token, spender } = req.body;
    if (!wallet || !token || !spender) {
      return res.status(400).json({ error: "wallet, token, spender required" });
    }

    const walletAddr = ethers.getAddress(wallet);
    const tokenAddr = ethers.getAddress(token);
    const spenderAddr = ethers.getAddress(spender);

    console.log("/attest request:", { wallet: walletAddr, token: tokenAddr, spender: spenderAddr });

    // 1) Neynar -> get FID
    let user;
    try {
      user = await getFarcasterUser(walletAddr);
    } catch (err) {
      console.error("Neynar request failed:", err?.message || err);
      return res.status(500).json({ error: "neynar lookup failed", details: err?.message || String(err) });
    }

    if (!user || !user.fid) {
      console.warn("Not a Farcaster user (neynar returned null or empty). neynarResponse:", !!user);
      return res.status(403).json({ error: "not a Farcaster user" });
    }
    const fid = Number(user.fid);
    console.log("Neynar user found:", { fid, username: user.username });

    // 2) Confirm revoke recorded on Base
    let revoked;
    try {
      revoked = await hasRevokedOnBase(walletAddr, tokenAddr, spenderAddr);
    } catch (err) {
      console.error("Log lookup failed:", err?.message || err);
      return res.status(500).json({ error: "log lookup failed", details: err?.message || String(err) });
    }
    if (!revoked) {
      console.warn("No revoke log found for", walletAddr);
      return res.status(400).json({ error: "no revoke recorded on base; call RevokeHelper.recordRevoked first" });
    }

    // 3) Build & sign EIP-712 attestation
    const nonce = BigInt(Date.now()).toString();
    const deadline = Math.floor(Date.now() / 1000) + 10 * 60; // 10 minutes
    const domain = buildDomain();
    const value = {
      wallet: walletAddr,
      fid,
      nonce,
      deadline,
      token: tokenAddr,
      spender: spenderAddr,
    };

    // sign
    const sig = await attesterWallet._signTypedData(domain, ATTEST_TYPES, value);

    console.log("Issuing attestation for fid", fid, "wallet", walletAddr);
    return res.json({ sig, nonce, deadline, fid, issuedBy: attesterWallet.address });
  } catch (err) {
    console.error("/attest error:", err?.message || err);
    return res.status(500).json({ error: "internal error", details: err?.message || String(err) });
  }
});

/* ---------- start ---------- */
app.listen(PORT, () => {
  console.log(`✅ Attester listening on :${PORT}. attester=${attesterWallet.address}`);
});
