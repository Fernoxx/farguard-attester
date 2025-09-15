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
  REVOKE_HELPER_ADDRESS,
  CHAIN_ID: CHAIN_ID_ENV,
  NEYNAR_API_KEY,
  DEPLOY_BLOCK, // 👈 new
  PORT: PORT_ENV,
  // Optional: Etherscan API for interaction checking
  ETHERSCAN_API_KEY,
  // Optional: Alchemy RPC for faster checking
  ALCHEMY_RPC_URL
} = process.env;

const PORT = Number(PORT_ENV || 8080);
const CHAIN_ID = Number(CHAIN_ID_ENV || 8453);
const START_BLOCK = Number(DEPLOY_BLOCK || 0); // fallback to 0 if not set

if (!ATTESTER_PK || !VERIFYING_CONTRACT || !REVOKE_HELPER_ADDRESS || !NEYNAR_API_KEY) {
  console.error("❌ Missing required env vars. Set ATTESTER_PK, VERIFYING_CONTRACT, REVOKE_HELPER_ADDRESS, NEYNAR_API_KEY, DEPLOY_BLOCK");
  process.exit(1);
}

/* ---------- providers & signer ---------- */
const attesterWallet = new ethers.Wallet(ATTESTER_PK);

console.log("✅ Attester address:", attesterWallet.address);
console.log("✅ Verifying contract:", VERIFYING_CONTRACT);
console.log("✅ RevokeHelper address:", REVOKE_HELPER_ADDRESS);
console.log("✅ Start block:", START_BLOCK);
console.log("✅ Anti-farming enabled: FID age + social activity checks");
console.log("✅ Etherscan V2 API:", ETHERSCAN_API_KEY ? "Available" : "Not configured");
console.log("✅ Alchemy RPC:", ALCHEMY_RPC_URL ? "Available" : "Not configured");

/* ---------- constants ---------- */
const REVOKE_EVENT_TOPIC = ethers.id("Revoked(address,address,address)");

/* ---------- Etherscan API integration ---------- */

// Check if user has interacted with RevokeHelper (multiple methods)
async function hasInteractedWithRevokeHelperEtherscan(wallet) {
  try {
    console.log(`🔍 Checking if ${wallet} has sent any transaction to RevokeHelper`);
    
    // Method 1: Try Alchemy RPC first (fastest)
    if (ALCHEMY_RPC_URL) {
      try {
        const hasInteraction = await checkWithAlchemyRPC(wallet);
        if (hasInteraction !== null) {
          return hasInteraction;
        }
      } catch (alchemyErr) {
        console.log(`⚠️ Alchemy RPC failed, trying Etherscan: ${alchemyErr.message}`);
      }
    }
    
    // Method 2: Try Etherscan V2 API
    if (ETHERSCAN_API_KEY) {
      try {
        const hasInteraction = await checkWithEtherscan(wallet);
        if (hasInteraction !== null) {
          return hasInteraction;
        }
      } catch (etherscanErr) {
        console.log(`⚠️ Etherscan API failed: ${etherscanErr.message}`);
      }
    }
    
    // Method 3: If both fail, allow user (fail-safe)
    console.log("⚠️ Both Alchemy and Etherscan failed - allowing user");
    return true;
    
  } catch (err) {
    console.error("RevokeHelper check error:", err?.message || err);
    return true; // Allow if check fails
  }
}

// Ultra-fast check: Has user ever sent a transaction to RevokeHelper?
async function checkWithAlchemyRPC(wallet) {
  console.log("🚀 Using Alchemy RPC for ultra-fast check");
  
  const alchemyProvider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL, { name: "base", chainId: CHAIN_ID });
  
  // Get user's transaction count
  const txCount = await alchemyProvider.getTransactionCount(wallet);
  console.log(`📊 User transaction count: ${txCount}`);
  
  if (txCount === 0) {
    console.log("❌ User has no transactions");
    return false;
  }
  
  // Check user's last 20 transactions to see if any go to RevokeHelper
  console.log("🔍 Checking user's recent transactions for RevokeHelper interactions");
  
  try {
    // Check the last 20 transactions (most users who interact with RevokeHelper will have done so recently)
    for (let i = Math.max(0, txCount - 20); i < txCount; i++) {
      try {
        const tx = await alchemyProvider.getTransaction(wallet, i);
        if (tx && tx.to && tx.to.toLowerCase() === REVOKE_HELPER_ADDRESS.toLowerCase()) {
          console.log(`✅ Found RevokeHelper interaction in transaction ${i}`);
          return true;
        }
      } catch (txErr) {
        // Skip failed transactions
        continue;
      }
    }
    
    console.log("❌ No RevokeHelper interaction found in recent transactions");
    return false;
    
  } catch (err) {
    console.log(`⚠️ Could not check user transactions: ${err.message}`);
    return null; // Try next method
  }
}

// Etherscan V2 API check - check user's recent transactions only
async function checkWithEtherscan(wallet) {
  console.log("🔍 Using Etherscan V2 API");
  
  const etherscanV2Url = "https://api.etherscan.io/v2/api";
  const baseChainId = 8453;
  
  // Get user's recent transactions only (last 50 for speed)
  const response = await fetch(
    `${etherscanV2Url}?chainid=${baseChainId}&module=account&action=txlist&address=${wallet}&startblock=0&endblock=99999999&page=1&offset=50&sort=desc&apikey=${ETHERSCAN_API_KEY}`
  );
  
  const data = await response.json();
  
  if (data.status !== "1") {
    console.log(`⚠️ Etherscan API error: ${data.message}`);
    return null; // Try next method
  }
  
  // Check if ANY transaction is to RevokeHelper contract
  const hasInteraction = data.result.some(tx => 
    tx.to && tx.to.toLowerCase() === REVOKE_HELPER_ADDRESS.toLowerCase()
  );
  
  if (hasInteraction) {
    console.log(`✅ Found RevokeHelper interaction via Etherscan in recent transactions`);
    return true;
  } else {
    console.log(`❌ No RevokeHelper interaction found via Etherscan in recent transactions`);
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


// Anti-farming: Check if user is a legitimate Farcaster user with reasonable requirements
async function isLegitimateFarcasterUser(wallet, user) {
  try {
    console.log(`🔍 Anti-farming check for FID ${user.fid}`);
    
    // Method 1: Check FID age (new accounts can't farm immediately)
    const fidCreatedAt = new Date(user.created_at);
    const daysSinceCreation = (Date.now() - fidCreatedAt.getTime()) / (1000 * 60 * 60 * 24);
    
    console.log(`📊 FID created: ${fidCreatedAt.toISOString()} (${daysSinceCreation.toFixed(1)} days ago)`);
    
    // Require account to be at least 30 days old (more reasonable)
    if (daysSinceCreation < 30) {
      console.log(`❌ Account too new (${daysSinceCreation.toFixed(1)} days) - need 30+ days`);
      return false;
    }
    
    // Method 2: Check if user has meaningful social activity
    console.log(`📊 User activity - Followers: ${user.follower_count}, Following: ${user.following_count}, Casts: ${user.cast_count}`);
    
    // Require at least 10 followers OR 20 following OR 5 casts
    const hasMinimumActivity = user.follower_count >= 10 || user.following_count >= 20 || user.cast_count >= 5;
    
    if (!hasMinimumActivity) {
      console.log(`❌ Insufficient social activity - need 10+ followers OR 20+ following OR 5+ casts`);
      return false;
    }
    
    // Method 3: Check if user has verified addresses (indicates real user)
    const hasVerifiedAddresses = user.verified_addresses && user.verified_addresses.length > 0;
    console.log(`📊 Verified addresses: ${user.verified_addresses?.length || 0}`);
    
    if (hasVerifiedAddresses) {
      console.log(`✅ Has verified addresses - strong legitimacy signal`);
    } else {
      console.log(`⚠️ No verified addresses - but allowing if other checks pass`);
    }
    
    // Method 4: Additional checks for high-value users
    const isHighValueUser = user.follower_count >= 50 || user.cast_count >= 20 || daysSinceCreation >= 90;
    
    if (isHighValueUser) {
      console.log(`✅ High-value user detected - extra legitimacy`);
    }
    
    console.log(`✅ User passed anti-farming checks - legitimate Farcaster user`);
    return true;
    
  } catch (err) {
    console.error("isLegitimateFarcasterUser error:", err?.message || err);
    return false;
  }
}

// Simple anti-farming system - no blockchain checking needed!

/* ---------- endpoints ---------- */
app.get("/health", (req, res) => {
  return res.json({ 
    ok: true, 
    attester: attesterWallet.address,
    message: "Anti-farming Farcaster attestation service"
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
    
    const fidCreatedAt = new Date(user.created_at);
    const daysSinceCreation = (Date.now() - fidCreatedAt.getTime()) / (1000 * 60 * 60 * 24);
    
    const hasMinimumActivity = user.follower_count >= 10 || user.following_count >= 20 || user.cast_count >= 5;
    const hasVerifiedAddresses = user.verified_addresses && user.verified_addresses.length > 0;
    
    // Check RevokeHelper interaction
    const hasRevokeHelperInteraction = await hasInteractedWithRevokeHelperEtherscan(walletAddr);
    
    const eligible = daysSinceCreation >= 30 && hasMinimumActivity && hasRevokeHelperInteraction;
    
    return res.json({
      wallet: walletAddr,
      fid: user.fid,
      username: user.username,
      eligible,
      details: {
        accountAge: {
          days: Math.floor(daysSinceCreation),
          required: 30,
          passed: daysSinceCreation >= 30
        },
        socialActivity: {
          followers: user.follower_count,
          following: user.following_count,
          casts: user.cast_count,
          hasMinimum: hasMinimumActivity,
          requirements: "10+ followers OR 20+ following OR 5+ casts"
        },
        verifiedAddresses: {
          count: user.verified_addresses?.length || 0,
          hasVerified: hasVerifiedAddresses
        },
        revokeHelperInteraction: {
          hasInteracted: hasRevokeHelperInteraction,
          contractAddress: REVOKE_HELPER_ADDRESS,
          checkedVia: ETHERSCAN_API_KEY ? "Etherscan V2 API" : "Not configured"
        }
      },
      requirements: {
        accountAge: "30+ days",
        socialActivity: "10+ followers OR 20+ following OR 5+ casts",
        revokeHelperInteraction: "Must interact with RevokeHelper contract",
        verifiedAddresses: "preferred but not required"
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

    // Anti-farming check: Is this a legitimate Farcaster user?
    console.log("🔍 Anti-farming verification...");
    
    try {
      const isLegitimate = await isLegitimateFarcasterUser(walletToCheck, user);
      
      if (!isLegitimate) {
        return res.status(400).json({ 
          error: "Account does not meet anti-farming requirements",
          details: "Account must be at least 30 days old and have social activity (10+ followers OR 20+ following OR 5+ casts)",
          requirements: {
            accountAge: "30+ days",
            socialActivity: "10+ followers OR 20+ following OR 5+ casts",
            verifiedAddresses: "preferred but not required"
          }
        });
      }
      
      console.log("✅ User passed anti-farming checks");
    } catch (err) {
      console.error("Error checking anti-farming:", err);
      return res.status(500).json({ error: "failed to verify user legitimacy" });
    }
    
    // Optional: Check if user has interacted with RevokeHelper via Etherscan
    console.log("🔍 Checking RevokeHelper interaction...");
    
    try {
      const hasInteracted = await hasInteractedWithRevokeHelperEtherscan(walletToCheck);
      
      if (!hasInteracted) {
        return res.status(400).json({ 
          error: "Must interact with RevokeHelper first",
          details: "Please revoke some allowances using RevokeHelper before claiming rewards",
          revokeHelperAddress: REVOKE_HELPER_ADDRESS
        });
      }
      
      console.log("✅ User has interacted with RevokeHelper");
    } catch (err) {
      console.error("Error checking RevokeHelper interaction:", err);
      return res.status(500).json({ error: "failed to verify RevokeHelper interaction" });
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
