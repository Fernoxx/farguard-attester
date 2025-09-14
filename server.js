// server.js - FarGuard Attester (Neynar-based FID check only)
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { ethers } from "ethers";
import axios from "axios";

dotenv.config();

/* ---------- env ---------- */
const PORT = process.env.PORT || 3000;
const ATTESTER_PK = process.env.ATTESTER_PK;
const VERIFYING_CONTRACT = process.env.VERIFYING_CONTRACT;
const REVOKE_HELPER_ADDRESS = process.env.REVOKE_HELPER_ADDRESS;
const BASE_RPC = process.env.BASE_RPC;
const CHAIN_ID = Number(process.env.CHAIN_ID || 8453);
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;

if (!ATTESTER_PK || !VERIFYING_CONTRACT || !REVOKE_HELPER_ADDRESS || !BASE_RPC || !NEYNAR_API_KEY) {
  console.error("❌ Missing env vars. Check ATTESTER_PK, VERIFYING_CONTRACT, REVOKE_HELPER_ADDRESS, BASE_RPC, NEYNAR_API_KEY");
  process.exit(1);
}

/* ---------- providers ---------- */
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, { name: "base", chainId: CHAIN_ID });
const attesterWallet = new ethers.Wallet(ATTESTER_PK);

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
  return { name: NAME, version: VERSION, chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT };
}

/* ---------- express ---------- */
const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());
app.set("trust proxy", 1);
app.use(rateLimit({ windowMs: 60_000, max: 60 }));

/* ---------- helpers ---------- */
async function getFarcasterUser(wallet) {
  const url = `https://api.neynar.com/v2/farcaster/user-by-verification?address=${wallet}`;
  try {
    const res = await axios.get(url, { headers: { "api_key": NEYNAR_API_KEY } });
    if (res.data && res.data.result && res.data.result.user) {
      return res.data.result.user; // includes fid
    }
    return null;
  } catch (err) {
    console.error("neynar error:", err?.response?.data || err.message);
    return null;
  }
}

async function hasRevokedOnBase(wallet, token, spender) {
  const eventTopic = ethers.id("Revoked(address,address,address)");
  const filter = {
    address: REVOKE_HELPER_ADDRESS,
    topics: [
      eventTopic,
      ethers.hexZeroPad(wallet, 32),
      ethers.hexZeroPad(token, 32),
      ethers.hexZeroPad(spender, 32),
    ],
    fromBlock: 0,
    toBlock: "latest",
  };
  const logs = await baseProvider.getLogs(filter);
  return logs.length > 0;
}

/* ---------- routes ---------- */
app.get("/health", (req, res) => {
  res.json({ ok: true, attester: attesterWallet.address });
});

app.post("/attest", async (req, res) => {
  try {
    const { wallet, token, spender } = req.body;
    if (!wallet || !token || !spender) {
      return res.status(400).json({ error: "wallet, token, spender required" });
    }

    const user = await getFarcasterUser(wallet);
    if (!user) return res.status(403).json({ error: "not a Farcaster user" });
    const fid = user.fid;

    const revoked = await hasRevokedOnBase(wallet, token, spender);
    if (!revoked) return res.status(400).json({ error: "no revoke recorded on base" });

    const nonce = BigInt(Date.now()).toString();
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const domain = buildDomain();
    const value = { wallet, fid, nonce, deadline, token, spender };

    const sig = await attesterWallet._signTypedData(domain, ATTEST_TYPES, value);

    return res.json({ sig, nonce, deadline, fid, issuedBy: attesterWallet.address });
  } catch (err) {
    console.error("/attest error:", err.message || err);
    res.status(500).json({ error: "internal error", details: err.message });
  }
});

/* ---------- start ---------- */
app.listen(PORT, () => {
  console.log(`✅ Attester running on port ${PORT}. Attester=${attesterWallet.address}`);
});
