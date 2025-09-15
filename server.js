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
      // Get the user data from the first entry (they all have the same FID)
      const userData = entries[0];
      
      // The provided wallet IS the user's selected primary wallet
      // We don't need to fetch the custody address - the user has already selected
      // which wallet they want to use as their primary wallet
      console.log(`✅ Using user-selected primary wallet: ${wallet} for FID ${userData.fid}`);
      
      return {
        ...userData,
        primary_wallet: wallet  // The provided wallet is the user's selected primary wallet
      };
    }
    return null;
  } catch (err) {
    console.error("getFarcasterUser error:", err?.message || err);
    throw new Error("neynar lookup failed");
  }
}


async function hasInteractedWithRevokeHelper(wallet) {
  try {
    console.log(`🔍 Checking if ${wallet} has interacted with RevokeHelper ${REVOKE_HELPER_ADDRESS}`);
    
    // Method 1: Check if wallet has made any transactions at all
    const txCount = await baseProvider.getTransactionCount(wallet);
    console.log(`📊 Wallet transaction count: ${txCount}`);
    
    if (txCount === 0) {
      console.log("❌ Wallet has never made any transactions");
      return false;
    }
    
    // Method 2: Check recent blocks for any transactions to RevokeHelper
    const currentBlock = await baseProvider.getBlockNumber();
    console.log(`📊 Current block: ${currentBlock}`);
    
    // Check last 1000 blocks (covers more history)
    const fromBlock = Math.max(START_BLOCK, currentBlock - 1000);
    console.log(`🔍 Checking blocks ${fromBlock} to ${currentBlock}`);
    
    try {
      // Get all logs from RevokeHelper in this range
      const logs = await baseProvider.getLogs({
        address: REVOKE_HELPER_ADDRESS,
        fromBlock,
        toBlock: currentBlock,
      });
      
      console.log(`📊 Found ${logs.length} total logs from RevokeHelper`);
      
      // Check each log's transaction
      for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        try {
          const tx = await baseProvider.getTransaction(log.transactionHash);
          if (tx && tx.from.toLowerCase() === wallet.toLowerCase()) {
            console.log(`✅ Found interaction: ${wallet} -> RevokeHelper in block ${log.blockNumber}`);
            return true;
          }
        } catch (txErr) {
          console.log(`⚠️ Could not fetch transaction ${log.transactionHash}`);
        }
      }
    } catch (err) {
      console.error(`❌ Error checking logs: ${err.message}`);
    }
    
    // Method 3: Check if wallet has any ERC20 approvals that might indicate interaction
    try {
      console.log("🔍 Checking for any ERC20 approvals...");
      // This is a fallback - if they have approvals, they might have interacted
      // But this is not reliable, so we'll just log it
    } catch (err) {
      console.log("Could not check ERC20 approvals");
    }
    
    console.log(`❌ No interaction found for ${wallet}`);
    return false;
  } catch (err) {
    console.error("hasInteractedWithRevokeHelper error:", err?.message || err);
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

    // Use the provided wallet (which is the user's selected primary wallet)
    const walletToCheck = walletAddr;
    console.log(`✅ Using user-selected primary wallet for interaction check: ${walletToCheck}`);

    // Simple check: has wallet interacted with RevokeHelper?
    console.log("🔍 Checking if wallet has interacted with RevokeHelper...");
    
    try {
      const hasInteracted = await hasInteractedWithRevokeHelper(walletToCheck);
      
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
    // Use the provided wallet (which is the user's selected primary wallet) for attestation
    const attestationWallet = walletAddr;
    console.log(`✅ Using user-selected primary wallet for attestation: ${attestationWallet}`);
    const value = { wallet: attestationWallet, fid, nonce, deadline, token: tokenAddr, spender: spenderAddr };

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
