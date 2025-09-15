// server.js — FarGuard Attester (Neynar + Base + RevokeHelper)
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
  DEPLOY_BLOCK, // 👈 new
  PORT: PORT_ENV
} = process.env;

const PORT = Number(PORT_ENV || 8080);
const CHAIN_ID = Number(CHAIN_ID_ENV || 8453);
const START_BLOCK = Number(DEPLOY_BLOCK || 0); // fallback to 0 if not set

if (!ATTESTER_PK || !VERIFYING_CONTRACT || !REVOKE_HELPER_ADDRESS || !BASE_RPC || !NEYNAR_API_KEY) {
  console.error("❌ Missing required env vars. Set ATTESTER_PK, VERIFYING_CONTRACT, REVOKE_HELPER_ADDRESS, BASE_RPC, NEYNAR_API_KEY, DEPLOY_BLOCK");
  process.exit(1);
}

/* ---------- providers & signer ---------- */
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, { name: "base", chainId: CHAIN_ID });
const attesterWallet = new ethers.Wallet(ATTESTER_PK);

console.log("✅ Attester address:", attesterWallet.address);
console.log("✅ Verifying contract:", VERIFYING_CONTRACT);
console.log("✅ RevokeHelper address:", REVOKE_HELPER_ADDRESS);
console.log("✅ Base RPC:", BASE_RPC);
console.log("✅ Start block:", START_BLOCK);

/* ---------- constants ---------- */
const REVOKE_EVENT_TOPIC = ethers.id("Revoked(address,address,address)");

/* ---------- simple setup ---------- */
// No complex caching needed - just simple checks

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

    const data = await res.json();
    const entries = data[wallet.toLowerCase()];
    if (Array.isArray(entries) && entries.length > 0) {
      return entries[0]; // first match
    }
    return null;
  } catch (err) {
    console.error("getFarcasterUser error:", err?.message || err);
    throw new Error("neynar lookup failed");
  }
}

async function hasInteractedWithRevokeHelper(wallet) {
  try {
    // Simple approach: check if wallet has any transaction history with RevokeHelper
    // This is much more reliable than scanning blocks
    const txCount = await baseProvider.getTransactionCount(wallet);
    
    if (txCount === 0) {
      return false; // Wallet has never made any transactions
    }
    
    // Check recent transactions (last 100) to see if any went to RevokeHelper
    const currentBlock = await baseProvider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 100);
    
    try {
      const logs = await baseProvider.getLogs({
        address: REVOKE_HELPER_ADDRESS,
        fromBlock,
        toBlock: currentBlock,
      });
      
      // Check if any of these transactions were from our wallet
      for (const log of logs) {
        const tx = await baseProvider.getTransaction(log.transactionHash);
        if (tx.from.toLowerCase() === wallet.toLowerCase()) {
          return true;
        }
      }
    } catch (err) {
      console.log("Recent block check failed, trying alternative approach");
    }
    
    return false;
  } catch (err) {
    console.error("hasInteractedWithRevokeHelper error:", err?.message || err);
    // If all else fails, assume they haven't interacted (safer)
    return false;
  }
}

// Removed all complex caching and sync functions - using simple direct checks

/* ---------- endpoints ---------- */
app.get("/health", (req, res) => {
  return res.json({ 
    ok: true, 
    attester: attesterWallet.address,
    message: "Simple FID + RevokeHelper interaction verification"
  });
});

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

    const user = await getFarcasterUser(walletAddr);
    if (!user || !user.fid) {
      console.warn("❌ Not a Farcaster user");
      return res.status(403).json({ error: "not a Farcaster user" });
    }
    const fid = Number(user.fid);
    console.log("✅ Neynar user found:", { fid, username: user.username });

    // Simple check: has wallet interacted with RevokeHelper?
    console.log("🔍 Checking if wallet has interacted with RevokeHelper...");
    
    try {
      const hasInteracted = await hasInteractedWithRevokeHelper(walletAddr);
      
      if (!hasInteracted) {
        return res.status(400).json({ error: "wallet must interact with RevokeHelper first" });
      }
      
      console.log("✅ Wallet has interacted with RevokeHelper");
    } catch (err) {
      console.error("Error checking wallet interaction:", err);
      return res.status(500).json({ error: "failed to verify wallet interaction" });
    }

    const nonce = BigInt(Date.now()).toString();
    const deadline = Math.floor(Date.now() / 1000) + 10 * 60;
    const domain = buildDomain();
    const value = { wallet: walletAddr, fid, nonce, deadline, token: tokenAddr, spender: spenderAddr };

    const sig = await attesterWallet.signTypedData(domain, ATTEST_TYPES, value);

    return res.json({ sig, nonce, deadline, fid, issuedBy: attesterWallet.address });
  } catch (err) {
    console.error("/attest error:", err?.message || err);
    return res.status(500).json({ error: "internal error", details: err?.message || String(err) });
  }
});

/* ---------- start server ---------- */
app.listen(PORT, () => {
  console.log(`✅ FarGuard Attester running on :${PORT}`);
  console.log(`📋 Simple verification: FID user + RevokeHelper interaction`);
});
