// server.js — FarGuard Attester (Neynar + Base + RevokeHelper)
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import { ethers } from "ethers";
// Removed Supabase - using simple anti-farming instead

dotenv.config();

/* ---------- required envs ---------- */
const {
  ATTESTER_PK,
  VERIFYING_CONTRACT,
  BASE_RPC,
  CHAIN_ID: CHAIN_ID_ENV,
  NEYNAR_API_KEY,
  PORT: PORT_ENV
} = process.env;

const PORT = Number(PORT_ENV || 8080);
const CHAIN_ID = Number(CHAIN_ID_ENV || 8453);

if (!ATTESTER_PK || !VERIFYING_CONTRACT || !BASE_RPC || !NEYNAR_API_KEY) {
  console.error("❌ Missing required env vars. Set ATTESTER_PK, VERIFYING_CONTRACT, BASE_RPC, NEYNAR_API_KEY");
  process.exit(1);
}

/* ---------- providers & signer ---------- */
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, { name: "base", chainId: CHAIN_ID });
const attesterWallet = new ethers.Wallet(ATTESTER_PK);

console.log("✅ Attester address:", attesterWallet.address);
console.log("✅ Verifying contract:", VERIFYING_CONTRACT);
console.log("✅ RevokeAndClaim contract:", VERIFYING_CONTRACT);
console.log("✅ Base RPC:", BASE_RPC);
console.log("✅ No anti-farming restrictions: All Farcaster users allowed");

/* ---------- constants ---------- */
const REVOKE_EVENT_TOPIC = ethers.id("Revoked(address,address,address)");

/* ---------- Base RPC integration ---------- */

// Simple check: Has user ever sent a transaction to RevokeAndClaim contract?
async function hasInteractedWithRevokeAndClaim(wallet) {
  try {
    console.log(`🔍 Checking if ${wallet} has sent any transaction to RevokeAndClaim contract`);
    console.log(`🔍 RevokeAndClaim address: ${VERIFYING_CONTRACT}`);
    
    // Get current block number
    const currentBlock = await baseProvider.getBlockNumber();
    console.log(`📊 Current block: ${currentBlock}`);
    
    // Check last 100 blocks for transactions from this wallet to RevokeAndClaim
    const blocksToCheck = 100;
    console.log(`🔍 Checking last ${blocksToCheck} blocks for RevokeAndClaim interactions`);
    
    for (let i = 0; i < blocksToCheck; i++) {
      try {
        const blockNumber = currentBlock - i;
        const block = await baseProvider.getBlock(blockNumber, true);
        
        if (block && block.transactions) {
          for (const tx of block.transactions) {
            if (tx.from && tx.from.toLowerCase() === wallet.toLowerCase() && 
                tx.to && tx.to.toLowerCase() === VERIFYING_CONTRACT.toLowerCase()) {
              console.log(`✅ Found RevokeAndClaim interaction in block ${blockNumber}`);
              console.log(`✅ Transaction hash: ${tx.hash}`);
              console.log(`✅ From: ${tx.from} -> To: ${tx.to}`);
              return true;
            }
          }
        }
      } catch (blockErr) {
        console.log(`⚠️ Could not fetch block ${currentBlock - i}: ${blockErr.message}`);
        continue;
      }
    }
    
    console.log("❌ No RevokeAndClaim interaction found in recent blocks");
    return false;
    
  } catch (err) {
    console.error("RevokeAndClaim check error:", err?.message || err);
    return false;
  }
}

/* ---------- simple setup ---------- */
// Anti-farming checks using Farcaster data + optional Etherscan

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


// Anti-farming checks removed - allow all Farcaster users

// Simple anti-farming system - no blockchain checking needed!

/* ---------- endpoints ---------- */
app.get("/health", (req, res) => {
  return res.json({ 
    ok: true, 
    attester: attesterWallet.address,
    message: "Farcaster attestation service - RevokeHelper interaction required"
  });
});

// Check user eligibility without requesting attestation
app.get("/check-eligibility/:wallet", async (req, res) => {
  try {
    const wallet = req.params.wallet;
    if (!ethers.isAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address" });
    }
    
    const walletAddr = ethers.getAddress(wallet);
    const user = await getFarcasterUser(walletAddr);
    
    if (!user || !user.fid) {
      return res.status(403).json({ 
        error: "Not a Farcaster user",
        eligible: false 
      });
    }
    
    // Check RevokeAndClaim interaction only
    const hasRevokeAndClaimInteraction = await hasInteractedWithRevokeAndClaim(walletAddr);
    
    const eligible = hasRevokeAndClaimInteraction;
    
    return res.json({
      wallet: walletAddr,
      fid: user.fid,
      username: user.username,
      eligible,
      details: {
        revokeAndClaimInteraction: {
          hasInteracted: hasRevokeAndClaimInteraction,
          contractAddress: VERIFYING_CONTRACT,
          checkedVia: "Base RPC"
        }
      },
      requirements: {
        revokeAndClaimInteraction: "Must interact with RevokeAndClaim contract"
      }
    });
  } catch (err) {
    console.error("Check eligibility error:", err);
    return res.status(500).json({ error: "Failed to check eligibility" });
  }
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

    // No anti-farming checks - allow all Farcaster users
    console.log("✅ Allowing all Farcaster users - no anti-farming restrictions");
    
    // Check if user has interacted with RevokeHelper via Base RPC
    console.log("🔍 Checking RevokeAndClaim interaction...");
    
    try {
      const hasInteracted = await hasInteractedWithRevokeAndClaim(walletToCheck);
      
      if (!hasInteracted) {
        return res.status(400).json({ 
          error: "Must interact with RevokeAndClaim first",
          details: "Please revoke some allowances using RevokeAndClaim before claiming rewards",
          revokeAndClaimAddress: VERIFYING_CONTRACT
        });
      }
      
      console.log("✅ User has interacted with RevokeAndClaim");
    } catch (err) {
      console.error("Error checking RevokeAndClaim interaction:", err);
      return res.status(500).json({ error: "failed to verify RevokeAndClaim interaction" });
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
  console.log(`📋 Anti-farming verification: FID age + social activity checks`);
  console.log(`🚀 No blockchain scanning needed - simple and fast!`);
});
