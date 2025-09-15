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

/* ---------- cache setup ---------- */
const revokedUsers = new Map(); // In-memory cache for fast access
let lastSyncBlock = START_BLOCK; // Track last synced block
let isSyncing = false; // Prevent concurrent syncs

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

async function hasRevokedOnBase(wallet, token, spender) {
  try {
    const topics = [
      REVOKE_EVENT_TOPIC,
      ethers.zeroPadValue(ethers.getAddress(wallet), 32),
      ethers.zeroPadValue(ethers.getAddress(token), 32),
      ethers.zeroPadValue(ethers.getAddress(spender), 32),
    ];

    const filter = {
      address: REVOKE_HELPER_ADDRESS,
      topics,
      fromBlock: START_BLOCK,   // ✅ use deployment block
      toBlock: "latest",
    };

    const logs = await baseProvider.getLogs(filter);
    return Array.isArray(logs) && logs.length > 0;
  } catch (err) {
    console.error("hasRevokedOnBase error:", err?.message || err);
    throw new Error("log lookup failed");
  }
}

/* ---------- real-time event listener ---------- */
function setupRealTimeListener() {
  try {
    console.log("🎧 Setting up real-time event listener...");
    
    const filter = {
      address: REVOKE_HELPER_ADDRESS,
      topics: [REVOKE_EVENT_TOPIC]
    };
    
    baseProvider.on(filter, (log) => {
      try {
        // Extract addresses from event topics
        const wallet = ethers.getAddress(log.topics[1].slice(-20));
        const token = ethers.getAddress(log.topics[2].slice(-20));
        const spender = ethers.getAddress(log.topics[3].slice(-20));
        
        const key = `${wallet}-${token}-${spender}`;
        revokedUsers.set(key, {
          wallet,
          token,
          spender,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          timestamp: Date.now()
        });
        
        console.log(`🎯 Real-time revoke detected: ${key} (block ${log.blockNumber})`);
      } catch (err) {
        console.error("Error processing real-time event:", err);
      }
    });
    
    console.log("✅ Real-time event listener active");
  } catch (err) {
    console.error("Failed to setup real-time listener:", err);
  }
}

/* ---------- cache sync function ---------- */
async function syncRevokedUsers(retryCount = 0, immediateSync = false) {
  if (isSyncing && !immediateSync) {
    console.log("⏳ Sync already in progress, skipping...");
    return;
  }

  isSyncing = true;
  try {
    const syncType = immediateSync ? "immediate" : "periodic";
    console.log(`🔄 ${syncType} sync from block ${lastSyncBlock}...`);
    
    // Get current block number
    const currentBlock = await baseProvider.getBlockNumber();
    console.log(`📊 Current block: ${currentBlock}, last sync: ${lastSyncBlock}`);
    
    let logs = [];
    
    if (immediateSync) {
      // For immediate sync, check last 200 blocks in chunks of 10
      // This covers ~4 seconds of blocks (200 blocks / 100 blocks per 2 sec)
      const fromBlock = Math.max(lastSyncBlock, currentBlock - 199); // 200 blocks total
      console.log(`🔍 Immediate sync: checking last 200 blocks (${fromBlock} to ${currentBlock})`);
      
      const MAX_BLOCK_RANGE = 10;
      let allLogs = [];
      let currentFromBlock = fromBlock;
      
      while (currentFromBlock <= currentBlock) {
        const currentToBlock = Math.min(currentFromBlock + MAX_BLOCK_RANGE - 1, currentBlock);
        
        const filter = {
          address: REVOKE_HELPER_ADDRESS,
          topics: [REVOKE_EVENT_TOPIC],
          fromBlock: currentFromBlock,
          toBlock: currentToBlock,
        };

        try {
          const chunkLogs = await baseProvider.getLogs(filter);
          allLogs = allLogs.concat(chunkLogs);
          if (chunkLogs.length > 0) {
            console.log(`✅ Found ${chunkLogs.length} events in blocks ${currentFromBlock}-${currentToBlock}`);
          }
        } catch (err) {
          console.error(`❌ Error fetching blocks ${currentFromBlock}-${currentToBlock}:`, err.message);
          // Continue with next chunk
        }
        
        currentFromBlock = currentToBlock + 1;
        
        // Small delay to avoid rate limiting
        if (currentFromBlock <= currentBlock) {
          await new Promise(resolve => setTimeout(resolve, 50)); // Faster delay for immediate sync
        }
      }
      
      logs = allLogs;
      console.log(`✅ Immediate sync found ${logs.length} events total`);
    } else {
      // For periodic sync, use chunked approach
      const fromBlock = lastSyncBlock;
      const MAX_BLOCK_RANGE = 10;
      let allLogs = [];
      let currentFromBlock = fromBlock;
      
      while (currentFromBlock <= currentBlock) {
        const currentToBlock = Math.min(currentFromBlock + MAX_BLOCK_RANGE - 1, currentBlock);
        
        console.log(`🔍 Fetching blocks ${currentFromBlock} to ${currentToBlock}...`);
        
        const filter = {
          address: REVOKE_HELPER_ADDRESS,
          topics: [REVOKE_EVENT_TOPIC],
          fromBlock: currentFromBlock,
          toBlock: currentToBlock,
        };

        try {
          const chunkLogs = await baseProvider.getLogs(filter);
          allLogs = allLogs.concat(chunkLogs);
          console.log(`✅ Found ${chunkLogs.length} events in blocks ${currentFromBlock}-${currentToBlock}`);
        } catch (err) {
          console.error(`❌ Error fetching blocks ${currentFromBlock}-${currentToBlock}:`, err.message);
          // Continue with next chunk
        }
        
        currentFromBlock = currentToBlock + 1;
        
        // Small delay to avoid rate limiting
        if (currentFromBlock <= currentBlock) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      logs = allLogs;
    }
    console.log(`📊 Found ${logs.length} revoke events total`);
    
    let newEntries = 0;
    let processedLogs = 0;
    
    logs.forEach((log, index) => {
      try {
        // Extract addresses from event topics
        const wallet = ethers.getAddress(log.topics[1].slice(-20));
        const token = ethers.getAddress(log.topics[2].slice(-20));
        const spender = ethers.getAddress(log.topics[3].slice(-20));
        
        const key = `${wallet}-${token}-${spender}`;
        console.log(`🔍 Event ${index + 1}: ${key} (block ${log.blockNumber})`);
        
        if (!revokedUsers.has(key)) {
          revokedUsers.set(key, {
            wallet,
            token,
            spender,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            timestamp: Date.now()
          });
          newEntries++;
          console.log(`✅ Added new entry: ${key}`);
        } else {
          console.log(`⏭️ Already cached: ${key}`);
        }
        processedLogs++;
      } catch (err) {
        console.error("Error processing log entry:", err);
      }
    });

    // Update last sync block
    if (logs.length > 0) {
      lastSyncBlock = Math.max(...logs.map(log => log.blockNumber)) + 1;
    }

    console.log(`✅ Sync completed: ${newEntries} new entries, ${processedLogs} processed, ${revokedUsers.size} total cached, last block: ${lastSyncBlock}`);
  } catch (err) {
    console.error("❌ Sync error:", err?.message || err);
    
    // Retry logic for RPC errors
    if (retryCount < 3 && (err.message?.includes('timeout') || err.message?.includes('rate limit'))) {
      console.log(`🔄 Retrying sync in 10 seconds... (attempt ${retryCount + 1}/3)`);
      setTimeout(() => {
        isSyncing = false;
        syncRevokedUsers(retryCount + 1);
      }, 10000);
      return;
    }
    
    // Don't throw error to prevent server crash
  } finally {
    isSyncing = false;
  }
}

/* ---------- cache check function ---------- */
function hasRevokedInCache(wallet, token, spender) {
  const key = `${wallet}-${token}-${spender}`;
  return revokedUsers.has(key);
}

/* ---------- endpoints ---------- */
app.get("/health", (req, res) => {
  return res.json({ 
    ok: true, 
    attester: attesterWallet.address,
    cache: {
      revokedUsersCount: revokedUsers.size,
      lastSyncBlock,
      isSyncing
    }
  });
});

// Manual sync endpoint for debugging
app.post("/sync", async (req, res) => {
  try {
    console.log("🔄 Manual sync requested");
    await syncRevokedUsers();
    return res.json({ 
      success: true, 
      message: "Sync completed",
      cache: {
        revokedUsersCount: revokedUsers.size,
        lastSyncBlock,
        isSyncing
      }
    });
  } catch (err) {
    console.error("Manual sync error:", err);
    return res.status(500).json({ error: "Sync failed", details: err?.message });
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

    // Check cache first
    let revoked = hasRevokedInCache(walletAddr, tokenAddr, spenderAddr);
    
    // If not in cache, try immediate sync to catch recent revokes
    if (!revoked) {
      console.log("🔄 Revoke not in cache, performing immediate sync...");
      console.log("🔍 Looking for:", { wallet: walletAddr, token: tokenAddr, spender: spenderAddr });
      try {
        await syncRevokedUsers(0, true); // immediateSync = true
        revoked = hasRevokedInCache(walletAddr, tokenAddr, spenderAddr);
        console.log("🔍 After immediate sync, revoked:", revoked);
        console.log("🔍 Cache size:", revokedUsers.size);
      } catch (err) {
        console.error("Immediate sync failed:", err);
        // Continue with cache check even if sync fails
      }
    }
    
    if (!revoked) {
      // Final fallback: check directly on blockchain (slow but accurate)
      console.log("🔄 Final fallback: checking blockchain directly...");
      try {
        const directCheck = await hasRevokedOnBase(walletAddr, tokenAddr, spenderAddr);
        if (directCheck) {
          console.log("✅ Found revoke via direct blockchain check, adding to cache");
          const key = `${walletAddr}-${tokenAddr}-${spenderAddr}`;
          revokedUsers.set(key, {
            wallet: walletAddr,
            token: tokenAddr,
            spender: spenderAddr,
            blockNumber: 'unknown',
            transactionHash: 'unknown',
            timestamp: Date.now()
          });
          revoked = true;
        }
      } catch (err) {
        console.error("Direct blockchain check failed:", err);
      }
    }
    
    if (!revoked) {
      return res.status(400).json({ error: "no revoke recorded; call RevokeHelper.recordRevoked first" });
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

/* ---------- startup and periodic sync ---------- */
async function initializeServer() {
  try {
    console.log("🚀 Initializing FarGuard Attester...");
    
    // Set up real-time event listener (most efficient)
    setupRealTimeListener();
    
    // Initial sync on startup to catch any missed events
    console.log("📡 Performing initial sync...");
    await syncRevokedUsers();
    
    // Set up periodic sync every 10 minutes as backup
    setInterval(async () => {
      await syncRevokedUsers();
    }, 10 * 60 * 1000); // 10 minutes (less frequent since we have real-time)
    
    console.log("⏰ Periodic sync scheduled every 10 minutes (backup)");
    
    // Start server
    app.listen(PORT, () => {
      console.log(`✅ Attester running on :${PORT}`);
      console.log(`📊 Cache status: ${revokedUsers.size} revoked users cached`);
    });
  } catch (err) {
    console.error("❌ Failed to initialize server:", err);
    process.exit(1);
  }
}

// Start the server
initializeServer();
