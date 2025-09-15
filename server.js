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
console.log("✅ Anti-farming enabled: FID age + social activity checks");

/* ---------- constants ---------- */
const REVOKE_EVENT_TOPIC = ethers.id("Revoked(address,address,address)");

/* ---------- simple setup ---------- */
// Anti-farming checks using Farcaster data only

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
    
    const eligible = daysSinceCreation >= 30 && hasMinimumActivity;
    
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
        }
      },
      requirements: {
        accountAge: "30+ days",
        socialActivity: "10+ followers OR 20+ following OR 5+ casts",
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

    // Simple anti-farming check: Is this a legitimate Farcaster user?
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
