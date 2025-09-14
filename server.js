// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import axios from "axios";
import { ethers } from "ethers";

dotenv.config();

const PORT = process.env.PORT || 3000;
const ATTESTER_PK = process.env.ATTESTER_PK;
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const VERIFYING_CONTRACT = process.env.VERIFYING_CONTRACT; // RevokeAndClaim address
const REVOKE_HELPER_ADDRESS = process.env.REVOKE_HELPER_ADDRESS; // RevokeHelper address
const BASE_RPC = process.env.BASE_RPC; // Base RPC (Alchemy/QuickNode/etc)
const CHAIN_ID = Number(process.env.CHAIN_ID || 8453);

if (!ATTESTER_PK || !NEYNAR_API_KEY || !VERIFYING_CONTRACT || !REVOKE_HELPER_ADDRESS || !BASE_RPC) {
  console.error("Missing required env vars");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "128kb" }));
app.use(cors());
app.use(helmet());
app.set("trust proxy", 1);
app.use(rateLimit({ windowMs: 60_000, max: 60, message: { error: "Too many requests" } }));

const provider = new ethers.JsonRpcProvider(BASE_RPC);
const attesterWallet = new ethers.Wallet(ATTESTER_PK);
const REVOKE_HELPER_ABI = ["function hasRevoked(address user,address token,address spender) view returns (bool)"];
const revokeHelper = new ethers.Contract(REVOKE_HELPER_ADDRESS, REVOKE_HELPER_ABI, provider);

const NAME = "RevokeAndClaim";
const VERSION = "1";
const TYPES = {
  Attestation: [
    { name: "wallet", type: "address" },
    { name: "fid", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "token", type: "address" },
    { name: "spender", type: "address" }
  ]
};

async function neynarResolveWallet(wallet) {
  const url = `https://api.neynar.com/v2/farcaster/user-by-verification?address=${wallet}`;
  const res = await axios.get(url, { headers: { api_key: process.env.NEYNAR_API_KEY } });
  return res.data?.result?.user ?? null;
}

app.post("/attest", async (req, res) => {
  try {
    const { wallet, fid, token, spender } = req.body;
    if (!wallet || fid === undefined || !token || !spender) {
      return res.status(400).json({ error: "wallet, fid, token, spender required" });
    }

    const walletAddr = ethers.getAddress(wallet);
    const tokenAddr = ethers.getAddress(token);
    const spenderAddr = ethers.getAddress(spender);

    // 1) Neynar verification: wallet must belong to fid
    let user;
    try {
      user = await neynarResolveWallet(walletAddr);
    } catch (err) {
      console.error("Neynar fetch error:", err?.response?.data ?? err?.message ?? err);
      return res.status(500).json({ error: "neynar error", details: String(err?.message || err) });
    }
    if (!user || Number(user.fid) !== Number(fid)) {
      return res.status(403).json({ error: "wallet not linked to fid" });
    }

    // 2) Check revoke recorded on-chain
    let revoked = false;
    try {
      revoked = await revokeHelper.hasRevoked(walletAddr, tokenAddr, spenderAddr);
    } catch (err) {
      console.error("revokeHelper.hasRevoked error:", err?.message || err);
      return res.status(500).json({ error: "revokeHelper check failed" });
    }
    if (!revoked) return res.status(400).json({ error: "no revoke recorded" });

    // 3) Sign attestation
    const nonce = BigInt(Date.now()).toString();
    const deadline = Math.floor(Date.now() / 1000) + 10 * 60; // 10 minutes TTL
    const domain = {
      name: NAME,
      version: VERSION,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT
    };
    const value = {
      wallet: walletAddr,
      fid: String(fid),
      nonce,
      deadline,
      token: tokenAddr,
      spender: spenderAddr
    };

    const sig = await attesterWallet._signTypedData(domain, TYPES, value);

    return res.json({ sig, nonce, deadline, fid: String(fid), issuedBy: attesterWallet.address });
  } catch (err) {
    console.error("/attest failed:", err?.message || err);
    return res.status(500).json({ error: "internal error", details: String(err?.message || err) });
  }
});

app.get("/health", (req, res) => {
  return res.json({ ok: true, attester: attesterWallet.address });
});

app.listen(PORT, () => {
  console.log(`Attester running on port ${PORT}, signer=${attesterWallet.address}`);
});
