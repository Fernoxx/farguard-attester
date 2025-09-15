import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { ethers } from "ethers";
import fetch from "node-fetch";

dotenv.config();

/* ---------- env ---------- */
const PORT = process.env.PORT || 8080;
const ATTESTER_PK = process.env.ATTESTER_PK;
const VERIFYING_CONTRACT = process.env.VERIFYING_CONTRACT;
const REVOKE_HELPER_ADDRESS = process.env.REVOKE_HELPER_ADDRESS;
const BASE_RPC = process.env.BASE_RPC;
const CHAIN_ID = Number(process.env.CHAIN_ID || 8453);
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;

if (!ATTESTER_PK || !VERIFYING_CONTRACT || !REVOKE_HELPER_ADDRESS || !BASE_RPC || !NEYNAR_API_KEY) {
  console.error("❌ Missing required env vars");
  process.exit(1);
}

/* ---------- providers & signer ---------- */
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, { name: "base", chainId: CHAIN_ID });
const attesterWallet = new ethers.Wallet(ATTESTER_PK);

// Minimal interface for RevokeHelper logs
const REVOKE_EVENT_TOPIC = ethers.id("Revoked(address,address,address)");

/* ---------- EIP-712 domain/types ---------- */
const NAME = "RevokeAndClaim";
const VERSION = "1";
const ATTEST_TYPES = {
  Attestation: [
    { name: "wallet", type: "address" },
    { name: "fid", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "token", type: "address" },
    { name: "spender", type: "address" }
  ]
};
function buildDomain() {
  return {
    name: NAME,
    version: VERSION,
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT
  };
}

/* ---------- express ---------- */
const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(cors());
app.use(helmet());
app.set("trust proxy", 1);
app.use(rateLimit({ windowMs: 60_000, max: 60, message: { error: "Too many requests" } }));

/* ---------- helpers ---------- */

// 1. Check Neynar for FID
async function getFarcasterUser(wallet) {
  const url = `https://api.neynar.com/v2/farcaster/user/bulk-by-address/?addresses[]=${wallet}`;
  const resp = await fetch(url, {
    headers: {
      "x-api-key": NEYNAR_API_KEY,
      "accept": "application/json",
      "x-neynar-experimental": "false"
    }
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Neynar API error: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  return data?.users?.[0] || null;
}

// 2. Check if revoked logged
async function hasRevokedOnBase(wallet, token, spender) {
  const topics = [
    REVOKE_EVENT_TOPIC,
    ethers.hexZeroPad(ethers.getAddress(wallet), 32),
    ethers.hexZeroPad(ethers.getAddress(token), 32),
    ethers.hexZeroPad(ethers.getAddress(spender), 32)
  ];
  const filter = { address: REVOKE_HELPER_ADDRESS, topics, fromBlock: 0, toBlock: "latest" };
  const logs = await baseProvider.getLogs(filter);
  return logs.length > 0;
}

/* ---------- endpoints ---------- */
app.get("/health", (req, res) => {
  return res.json({ ok: true, attester: attesterWallet.address });
});

app.post("/attest", async (req, res) => {
  try {
    const { wallet, token, spender } = req.body;
    if (!wallet || !token || !spender) {
      return res.status(400).json({ error: "wallet, token, spender required" });
    }

    const walletAddr = ethers.getAddress(wallet);

    // 1. Check if Farcaster user
    const user = await getFarcasterUser(walletAddr);
    if (!user?.fid) {
      return res.status(403).json({ error: "not a Farcaster user" });
    }
    const fid = user.fid;

    // 2. Ensure revoke recorded
    const revoked = await hasRevokedOnBase(walletAddr, token, spender);
    if (!revoked) {
      return res.status(400).json({ error: "no revoke recorded" });
    }

    // 3. Sign attestation
    const nonce = BigInt(Date.now()).toString();
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const domain = buildDomain();
    const value = { wallet: walletAddr, fid, nonce, deadline, token, spender };
    const sig = await attesterWallet._signTypedData(domain, ATTEST_TYPES, value);

    return res.json({ sig, nonce, deadline, fid, issuedBy: attesterWallet.address });
  } catch (err) {
    console.error("/attest error:", err);
    return res.status(500).json({ error: "internal error", details: err.message });
  }
});

/* ---------- start ---------- */
app.listen(PORT, () => {
  console.log(`✅ Attester running on port ${PORT}. attester=${attesterWallet.address}`);
});
