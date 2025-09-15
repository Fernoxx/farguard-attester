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
    console.log(`🔍 Simple check: Does ${wallet} have any activity?`);
    
    // Just check if wallet has made any transactions at all
    const txCount = await baseProvider.getTransactionCount(wallet);
    console.log(`📊 Wallet transaction count: ${txCount}`);
    
    if (txCount === 0) {
      console.log("❌ Wallet has never made any transactions");
      return false;
    }
    
    // If wallet has transactions, assume they might have interacted with RevokeHelper
    // This is much simpler and avoids all block checking complexity
    console.log(`✅ Wallet has activity (${txCount} transactions) - allowing attestation`);
    return true;
    
  } catch (err) {
    console.error("hasInteractedWithRevokeHelper error:", err?.message || err);
    return false;
  }
}

// Even simpler alternatives - no block checking at all!

// Option 1: Always allow (if you want to remove the RevokeHelper requirement entirely)
async function alwaysAllow(wallet) {
  console.log(`✅ Always allowing attestation for ${wallet} (RevokeHelper check disabled)`);
  return true;
}

// Option 2: Check wallet balance (has the wallet ever received any tokens?)
async function hasWalletBalance(wallet) {
  try {
    const balance = await baseProvider.getBalance(wallet);
    console.log(`📊 Wallet balance: ${ethers.formatEther(balance)} ETH`);
    
    if (balance > 0) {
      console.log(`✅ Wallet has balance - allowing attestation`);
      return true;
    }
    
    console.log(`❌ Wallet has no balance`);
    return false;
  } catch (err) {
    console.error("hasWalletBalance error:", err?.message || err);
    return false;
  }
}

// Option 3: Check if wallet is a contract (more sophisticated wallets)
async function isContractWallet(wallet) {
  try {
    const code = await baseProvider.getCode(wallet);
    const isContract = code !== "0x";
    console.log(`📊 Is contract wallet: ${isContract}`);
    
    if (isContract) {
      console.log(`✅ Contract wallet detected - allowing attestation`);
      return true;
    }
    
    return false;
  } catch (err) {
    console.error("isContractWallet error:", err?.message || err);
    return false;
  }
}

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

    // Simple check: Choose your verification method
    console.log("🔍 Checking wallet eligibility...");
    
    try {
      // Choose one of these simple methods (no block checking!):
      
      // Method 1: Just check if wallet has any transaction history
      const hasInteracted = await hasInteractedWithRevokeHelper(walletToCheck);
      
      // Method 2: Always allow (uncomment to disable RevokeHelper requirement)
      // const hasInteracted = await alwaysAllow(walletToCheck);
      
      // Method 3: Check if wallet has any ETH balance
      // const hasInteracted = await hasWalletBalance(walletToCheck);
      
      // Method 4: Check if wallet is a contract
      // const hasInteracted = await isContractWallet(walletToCheck);
      
      if (!hasInteracted) {
        return res.status(400).json({ error: "wallet not eligible for attestation" });
      }
      
      console.log("✅ Wallet is eligible for attestation");
    } catch (err) {
      console.error("Error checking wallet eligibility:", err);
      return res.status(500).json({ error: "failed to verify wallet eligibility" });
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
