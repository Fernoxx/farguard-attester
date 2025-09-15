import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { ethers } from "ethers";
import pkg from "@neynar/nodejs-sdk";

const { NeynarAPIClient, Configuration } = pkg;

dotenv.config();

/* ---------- env ---------- */
const PORT = process.env.PORT || 3000;
const ATTESTER_PK = process.env.ATTESTER_PK;
const VERIFYING_CONTRACT = process.env.VERIFYING_CONTRACT;
const REVOKE_HELPER_ADDRESS = process.env.REVOKE_HELPER_ADDRESS;
const BASE_RPC = process.env.BASE_RPC;
const CHAIN_ID = Number(process.env.CHAIN_ID || 8453);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;

if (!ATTESTER_PK || !VERIFYING_CONTRACT || !REVOKE_HELPER_ADDRESS || !BASE_RPC || !NEYNAR_API_KEY) {
  console.error("❌ Missing required env vars");
  process.exit(1);
}

/* ---------- providers & contracts ---------- */
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, { name: "base", chainId: CHAIN_ID });
const attesterWallet = new ethers.Wallet(ATTESTER_PK);

// ✅ Correct initialization for Neynar client
const neynarConfig = new Configuration({ apiKey: NEYNAR_API_KEY });
const neynarClient = new NeynarAPIClient(neynarConfig);

// Minimal interface for RevokeHelper: event Revoked(address,address,address)
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

// Check if RevokeHelper emitted Revoked(wallet, token, spender) on Base
async function hasRevokedOnBase(wallet, token, spender) {
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

// health
app.get("/health", (req, res) => {
  return res.json({ ok: true, attester: attesterWallet.address });
});

// attest
app.post("/attest", async (req, res) => {
  try {
    const { wallet, token, spender } = req.body;
    if (!wallet || !token || !spender) {
      return res.status(400).json({ error: "wallet, token, spender required" });
    }

    const walletAddr = ethers.getAddress(wallet);
    const tokenAddr = ethers.getAddress(token);
    const spenderAddr = ethers.getAddress(spender);

    // 1. Verify wallet is a Farcaster user via Neynar
    const userResp = await neynarClient.fetchBulkUsersByEthOrSolAddress({ addresses: [walletAddr] });
    const user = userResp?.result?.user;
    if (!user || !user.fid) {
      return res.status(403).json({ error: "not a Farcaster user" });
    }
    const fid = user.fid;

    // 2. Verify revoke recorded
    const revoked = await hasRevokedOnBase(walletAddr, tokenAddr, spenderAddr);
    if (!revoked) {
      return res.status(400).json({ error: "no revoke recorded on base; call RevokeHelper.recordRevoked first" });
    }

    // 3. Build + sign attestation
    const nonce = BigInt(Date.now()).toString();
    const deadline = Math.floor(Date.now() / 1000) + 10 * 60;
    const domain = buildDomain();
    const value = { wallet: walletAddr, fid, nonce, deadline, token: tokenAddr, spender: spenderAddr };

    const sig = await attesterWallet._signTypedData(domain, ATTEST_TYPES, value);

    return res.json({ sig, nonce, deadline, fid, issuedBy: attesterWallet.address });
  } catch (err) {
    console.error("/attest error:", err?.message || err);
    return res.status(500).json({ error: "internal error", details: err?.message || String(err) });
  }
});

/* ---------- start ---------- */
app.listen(PORT, () => {
  console.log(`✅ Attester running on port ${PORT}. attester=${attesterWallet.address}`);
});
