// server.js — FarGuard attester (Option B: custody check on Optimism + revoke log on Base)
// Node: ESM
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { ethers } from "ethers";

dotenv.config();

/* ---------- env ---------- */
const PORT = process.env.PORT || 3000;
const ATTESTER_PK = process.env.ATTESTER_PK;
const VERIFYING_CONTRACT = process.env.VERIFYING_CONTRACT;
const REVOKE_HELPER_ADDRESS = process.env.REVOKE_HELPER_ADDRESS;
const IDREGISTRY_ADDRESS = process.env.IDREGISTRY_ADDRESS;
const BASE_RPC = process.env.BASE_RPC;
const OPTIMISM_RPC = process.env.OPTIMISM_RPC;
const CHAIN_ID = Number(process.env.CHAIN_ID || 8453);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);

if (!ATTESTER_PK || !VERIFYING_CONTRACT || !REVOKE_HELPER_ADDRESS || !IDREGISTRY_ADDRESS || !BASE_RPC || !OPTIMISM_RPC) {
  console.error("Missing required env vars. Check ATTESTER_PK, VERIFYING_CONTRACT, REVOKE_HELPER_ADDRESS, IDREGISTRY_ADDRESS, BASE_RPC, OPTIMISM_RPC");
  process.exit(1);
}

/* ---------- providers & contracts ---------- */
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, { name: "base", chainId: CHAIN_ID });
const optimismProvider = new ethers.JsonRpcProvider(OPTIMISM_RPC); // chainId not required for read-only

const attesterWallet = new ethers.Wallet(ATTESTER_PK); // no provider needed for signing only

// Minimal ABI for IDRegistry: custodyOf(uint256)
const IDREGISTRY_ABI = [
  "function custodyOf(uint256 fid) view returns (address)"
];
// Minimal interface for checking RevokeHelper event: event Revoked(address indexed wallet, address indexed token, address indexed spender)
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
// trust proxy for PaaS (Railway)
app.set("trust proxy", 1);
app.use(rateLimit({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX, message: { error: "Too many requests" } }));

/* ---------- helpers ---------- */

/**
 * Check custody on Optimism: returns address or null+throws
 */
async function getCustodyAddressForFid(fid) {
  const idRegistry = new ethers.Contract(IDREGISTRY_ADDRESS, IDREGISTRY_ABI, optimismProvider);
  try {
    const custody = await idRegistry.custodyOf(ethers.BigInt(fid));
    return ethers.getAddress(custody);
  } catch (err) {
    console.error("idRegistry.custodyOf error:", err?.message || err);
    throw new Error("idRegistry lookup failed");
  }
}

/**
 * Check if RevokeHelper emitted Revoked(wallet, token, spender) on Base
 * Uses getLogs with indexed topics (wallet, token, spender) to find any matching log.
 */
async function hasRevokedOnBase(wallet, token, spender) {
  // topics: [eventTopic, wallet, token, spender] (indexed)
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

  try {
    const logs = await baseProvider.getLogs(filter);
    return Array.isArray(logs) && logs.length > 0;
  } catch (err) {
    console.error("getLogs error:", err?.message || err);
    throw new Error("log lookup failed");
  }
}

/* ---------- endpoints ---------- */

/**
 * Health
 */
app.get("/health", (req, res) => {
  return res.json({ ok: true, attester: attesterWallet.address });
});

/**
 * /attest
 * Body: { wallet, fid, token, spender }
 * Requirements:
 *  - wallet must equal custodyOf(fid) on Optimism
 *  - RevokeHelper must have emitted Revoked(wallet, token, spender) on Base
 * Returns: { sig, nonce, deadline, fid, issuedBy }
 */
app.post("/attest", async (req, res) => {
  try {
    const { wallet, fid, token, spender } = req.body;
    if (!wallet || fid === undefined || !token || !spender) {
      return res.status(400).json({ error: "wallet, fid, token, spender required" });
    }

    // normalize
    const walletAddr = ethers.getAddress(wallet);
    const tokenAddr = ethers.getAddress(token);
    const spenderAddr = ethers.getAddress(spender);

    // 1) custody check on Optimism
    const custody = await getCustodyAddressForFid(fid);
    if (custody.toLowerCase() !== walletAddr.toLowerCase()) {
      return res.status(403).json({ error: "wallet not custody for fid" });
    }

    // 2) check revoke recorded on base
    const revoked = await hasRevokedOnBase(walletAddr, tokenAddr, spenderAddr);
    if (!revoked) {
      return res.status(400).json({ error: "no revoke recorded on base; call RevokeHelper.recordRevoked first" });
    }

    // 3) build EIP-712 attestation
    const nonce = BigInt(Date.now()).toString();
    const deadline = Math.floor(Date.now() / 1000) + 10 * 60; // 10 minutes
    const domain = buildDomain();
    const value = {
      wallet: walletAddr,
      fid: String(fid),
      nonce,
      deadline,
      token: tokenAddr,
      spender: spenderAddr,
    };

    const signature = await attesterWallet._signTypedData(domain, ATTEST_TYPES, value);

    return res.json({ sig: signature, nonce, deadline, fid: String(fid), issuedBy: attesterWallet.address });
  } catch (err) {
    console.error("/attest error:", err?.message || err);
    return res.status(500).json({ error: "internal error", details: err?.message || String(err) });
  }
});

/* ---------- start ---------- */
app.listen(PORT, () => {
  console.log(`Attester running on port ${PORT}. attester=${attesterWallet.address}`);
});
