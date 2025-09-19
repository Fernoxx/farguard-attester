// server.js — FarGuard Attester (Neynar + Base + RevokeHelper + Supabase)
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import { ethers } from "ethers";
import { createClient } from '@supabase/supabase-js';

dotenv.config();

/* ---------- required envs ---------- */
const {
  ATTESTER_PK,
  VERIFYING_CONTRACT,
  BASE_RPC,
  CHAIN_ID: CHAIN_ID_ENV,
  NEYNAR_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PORT: PORT_ENV
} = process.env;

const PORT = Number(PORT_ENV || 8080);
const CHAIN_ID = Number(CHAIN_ID_ENV || 8453);

if (!ATTESTER_PK || !VERIFYING_CONTRACT || !BASE_RPC || !NEYNAR_API_KEY) {
  console.error("❌ Missing required env vars. Set ATTESTER_PK, VERIFYING_CONTRACT, BASE_RPC, NEYNAR_API_KEY");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌ Missing Supabase env vars. Set SUPABASE_URL, SUPABASE_SERVICE_KEY");
  process.exit(1);
}

/* ---------- providers & signer ---------- */
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, { name: "base", chainId: CHAIN_ID });
const attesterWallet = new ethers.Wallet(ATTESTER_PK);

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

console.log("✅ Attester address:", attesterWallet.address);
console.log("✅ Verifying contract:", VERIFYING_CONTRACT);
console.log("✅ RevokeAndClaim contract:", VERIFYING_CONTRACT);
console.log("✅ Base RPC:", BASE_RPC);
console.log("✅ Supabase connected:", !!supabase);
console.log("✅ Revocation verification: Database + RevokeHelper required");

/* ---------- simple setup ---------- */

const NAME = "RevokeAndClaim";
const VERSION = "1";
const ATTEST_TYPES = {
  Attestation: [
    { name: "user", type: "address" },  // CHANGED: "wallet" -> "user" to match contract
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
      const userData = entries[0];
      console.log(`✅ Using user-selected primary wallet: ${wallet} for FID ${userData.fid}`);
      
      return {
        ...userData,
        primary_wallet: wallet
      };
    }
    return null;
  } catch (err) {
    console.error("getFarcasterUser error:", err?.message || err);
    throw new Error("neynar lookup failed");
  }
}

// Check if user has revoked using RevokeHelper (from database)
async function checkRevocationInDB(wallet, token, spender) {
  try {
    console.log(`🔍 Checking revocation in database for: ${wallet}, ${token}, ${spender}`);
    
    const { data, error } = await supabase
      .from('revocations')
      .select('*')
      .eq('wallet', wallet.toLowerCase())
      .eq('token', token.toLowerCase())
      .eq('spender', spender.toLowerCase())
      .single();
    
    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('Database error:', error);
      return { hasRevoked: false, error: 'Database error' };
    }
    
    const hasRevoked = !!data;
    console.log(`✅ Database check result: ${hasRevoked ? 'HAS REVOKED' : 'HAS NOT REVOKED'}`);
    
    return { hasRevoked, data };
  } catch (error) {
    console.error('Error checking revocation in database:', error);
    return { hasRevoked: false, error: error.message };
  }
}

// Optional: Check RevokeHelper contract directly (as backup)
async function checkRevocationOnChain(wallet, token, spender) {
  try {
    const REVOKE_HELPER_ADDRESS = "0x3acb4672fec377bd62cf4d9a0e6bdf5f10e5caaf";
    const hasRevokedABI = [
      "function hasRevoked(address user, address token, address spender) external view returns (bool)"
    ];
    
    const revokeHelper = new ethers.Contract(REVOKE_HELPER_ADDRESS, hasRevokedABI, baseProvider);
    const hasRevoked = await revokeHelper.hasRevoked(wallet, token, spender);
    
    console.log(`🔗 On-chain check result: ${hasRevoked ? 'HAS REVOKED' : 'HAS NOT REVOKED'}`);
    return { hasRevoked, source: 'on-chain' };
  } catch (error) {
    console.error('Error checking revocation on-chain:', error);
    return { hasRevoked: false, error: error.message, source: 'on-chain' };
  }
}

/* ---------- endpoints ---------- */
app.get("/health", (req, res) => {
  return res.json({ 
    ok: true, 
    attester: attesterWallet.address,
    supabase: !!supabase,
    message: "Farcaster attestation service - RevokeHelper + Database verification required"
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
    
    const fid = Number(user.fid);
    
    return res.json({
      wallet: walletAddr,
      fid: user.fid,
      username: user.username,
      eligible: true,
      details: {
        farcasterUser: {
          isFarcasterUser: true,
          fid: user.fid,
          username: user.username
        }
      },
      requirements: {
        farcasterAccount: "Must have a valid Farcaster account",
        revocationRequired: "Must revoke using RevokeHelper before claiming"
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

    // Step 1: Verify Farcaster user
    const user = await getFarcasterUser(walletAddr);
    if (!user || !user.fid) {
      console.warn("❌ Not a Farcaster user");
      return res.status(403).json({ error: "not a Farcaster user" });
    }
    const fid = Number(user.fid);
    console.log("✅ Neynar user found:", { fid, username: user.username });

    // Step 2: Check if user has revoked using RevokeHelper
    console.log("🔍 Checking if user has revoked using RevokeHelper...");
    const dbCheck = await checkRevocationInDB(walletAddr, tokenAddr, spenderAddr);
    
    if (!dbCheck.hasRevoked) {
      console.warn("❌ User has not revoked using RevokeHelper");
      return res.status(403).json({ 
        error: "User must revoke using RevokeHelper before claiming",
        details: "No revocation found in database for this wallet/token/spender combination"
      });
    }
    
    console.log("✅ User has revoked using RevokeHelper - proceeding with attestation");

    // Step 3: Generate attestation with DEBUG LOGGING
    const nonce = BigInt(Date.now()).toString();
    const deadline = Math.floor(Date.now() / 1000) + 10 * 60;
    const domain = buildDomain();
    
    // CHANGED: Use "user" instead of "wallet" to match contract
    const value = { user: walletAddr, fid, nonce, deadline, token: tokenAddr, spender: spenderAddr };

    // ADDED: Debug logging
    console.log("🔍 EIP-712 Domain:", domain);
    console.log("🔍 EIP-712 Types:", ATTEST_TYPES);
    console.log("🔍 Message to sign:", value);
    console.log("🔍 Attester wallet address:", attesterWallet.address);

    console.log("🔍 Signing attestation with values:", value);
    const sig = await attesterWallet.signTypedData(domain, ATTEST_TYPES, value);
    console.log("✅ Attestation signed successfully");

    const response = { sig, nonce, deadline, fid, issuedBy: attesterWallet.address };
    console.log("📤 Sending response:", response);
    
    // Add CORS headers
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    return res.json(response);
  } catch (err) {
    console.error("/attest error:", err?.message || err);
    return res.status(500).json({ error: "internal error", details: err?.message || String(err) });
  }
});

// Check specific revocation status
app.get("/check-revocation/:wallet/:token/:spender", async (req, res) => {
  try {
    const { wallet, token, spender } = req.params;
    
    if (!ethers.isAddress(wallet) || !ethers.isAddress(token) || !ethers.isAddress(spender)) {
      return res.status(400).json({ error: "Invalid addresses" });
    }
    
    const walletAddr = ethers.getAddress(wallet);
    const tokenAddr = ethers.getAddress(token);
    const spenderAddr = ethers.getAddress(spender);
    
    console.log("🔍 Checking revocation status...");
    
    // Check database
    const dbCheck = await checkRevocationInDB(walletAddr, tokenAddr, spenderAddr);
    
    // Optional: Check on-chain as backup
    const onChainCheck = await checkRevocationOnChain(walletAddr, tokenAddr, spenderAddr);
    
    return res.json({
      wallet: walletAddr,
      token: tokenAddr,
      spender: spenderAddr,
      database: {
        hasRevoked: dbCheck.hasRevoked,
        data: dbCheck.data,
        error: dbCheck.error
      },
      onChain: {
        hasRevoked: onChainCheck.hasRevoked,
        error: onChainCheck.error
      },
      status: dbCheck.hasRevoked ? "✅ Can claim" : "❌ Must revoke first"
    });
    
  } catch (error) {
    console.error("Check revocation error:", error);
    return res.status(500).json({ error: "Failed to check revocation", details: error.message });
  }
});

// Simple test endpoint
app.get("/test", (req, res) => {
  res.json({ status: "ok", message: "Server is working", timestamp: new Date().toISOString() });
});

// Debug endpoint to check what's happening
app.get("/debug/:wallet", async (req, res) => {
  try {
    const wallet = req.params.wallet;
    if (!ethers.isAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address" });
    }
    
    const walletAddr = ethers.getAddress(wallet);
    console.log(`🔍 Debug check for wallet: ${walletAddr}`);
    
    const user = await getFarcasterUser(walletAddr);
    if (!user || !user.fid) {
      return res.json({
        wallet: walletAddr,
        isFarcasterUser: false,
        error: "Not a Farcaster user"
      });
    }
    
    const fid = Number(user.fid);
    
    return res.json({
      wallet: walletAddr,
      isFarcasterUser: true,
      fid: fid,
      username: user.username,
      canClaim: "Must revoke first",
      verifiedBy: "Neynar API + Database check required"
    });
  } catch (err) {
    console.error("Debug error:", err);
    return res.status(500).json({ error: "Debug failed", details: err?.message });
  }
});

/* ---------- start server ---------- */
app.listen(PORT, () => {
  console.log(`✅ FarGuard Attester running on :${PORT}`);
  console.log(`📊 Supabase connected: ${!!supabase}`);
  console.log(`🔍 Revocation verification: Database + RevokeHelper required`);
  console.log(`🚀 Only users who actually revoked can claim rewards!`);
});
