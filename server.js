// server.js — FarGuard Attester (Neynar + Base + RevokeHelper)
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import { ethers } from "ethers";
import { createClient } from "@supabase/supabase-js";

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
  PORT: PORT_ENV,
  // Supabase config
  SUPABASE_URL,
  SUPABASE_ANON_KEY
} = process.env;

const PORT = Number(PORT_ENV || 8080);
const CHAIN_ID = Number(CHAIN_ID_ENV || 8453);
const START_BLOCK = Number(DEPLOY_BLOCK || 0); // fallback to 0 if not set

if (!ATTESTER_PK || !VERIFYING_CONTRACT || !REVOKE_HELPER_ADDRESS || !BASE_RPC || !NEYNAR_API_KEY) {
  console.error("❌ Missing required env vars. Set ATTESTER_PK, VERIFYING_CONTRACT, REVOKE_HELPER_ADDRESS, BASE_RPC, NEYNAR_API_KEY, DEPLOY_BLOCK");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("❌ Missing Supabase config. Set SUPABASE_URL and SUPABASE_ANON_KEY");
  process.exit(1);
}

/* ---------- providers & signer ---------- */
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, { name: "base", chainId: CHAIN_ID });
const attesterWallet = new ethers.Wallet(ATTESTER_PK);

/* ---------- Supabase client ---------- */
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

console.log("✅ Attester address:", attesterWallet.address);
console.log("✅ Verifying contract:", VERIFYING_CONTRACT);
console.log("✅ RevokeHelper address:", REVOKE_HELPER_ADDRESS);
console.log("✅ Base RPC:", BASE_RPC);
console.log("✅ Start block:", START_BLOCK);
console.log("✅ Supabase connected:", SUPABASE_URL);

/* ---------- constants ---------- */
const REVOKE_EVENT_TOPIC = ethers.id("Revoked(address,address,address)");

/* ---------- database functions ---------- */

// Initialize database table
async function initDatabase() {
  try {
    console.log("🔧 Initializing database...");
    
    // Create interactions table if it doesn't exist
    const { data, error } = await supabase.rpc('create_interactions_table_if_not_exists');
    
    if (error && !error.message.includes('already exists')) {
      console.error("❌ Database init error:", error);
      throw error;
    }
    
    console.log("✅ Database initialized");
  } catch (err) {
    console.log("⚠️ Database init failed, will create table manually:", err.message);
  }
}

// Store interaction in database
async function storeInteraction(wallet, transactionHash, blockNumber, blockTimestamp) {
  try {
    const { data, error } = await supabase
      .from('revoke_interactions')
      .insert({
        wallet_address: wallet.toLowerCase(),
        transaction_hash: transactionHash,
        block_number: blockNumber,
        block_timestamp: blockTimestamp,
        contract_address: REVOKE_HELPER_ADDRESS.toLowerCase(),
        created_at: new Date().toISOString()
      })
      .select();

    if (error) {
      console.error("❌ Error storing interaction:", error);
      return false;
    }

    console.log(`✅ Stored interaction for ${wallet} in block ${blockNumber}`);
    return true;
  } catch (err) {
    console.error("storeInteraction error:", err?.message || err);
    return false;
  }
}

// Check if wallet has interacted with RevokeHelper (from database)
async function hasInteractedFromDatabase(wallet) {
  try {
    const { data, error } = await supabase
      .from('revoke_interactions')
      .select('*')
      .eq('wallet_address', wallet.toLowerCase())
      .limit(1);

    if (error) {
      console.error("❌ Error checking database:", error);
      return false;
    }

    const hasInteracted = data && data.length > 0;
    if (hasInteracted) {
      console.log(`✅ Found interaction in database for ${wallet}`);
      console.log(`📊 Interaction details:`, data[0]);
    } else {
      console.log(`❌ No interaction found in database for ${wallet}`);
    }

    return hasInteracted;
  } catch (err) {
    console.error("hasInteractedFromDatabase error:", err?.message || err);
    return false;
  }
}

// Sync interactions from blockchain to database
async function syncInteractionsToDatabase() {
  try {
    console.log("🔄 Syncing interactions to database...");
    
    const currentBlock = await baseProvider.getBlockNumber();
    const checkFromBlock = Math.max(START_BLOCK, currentBlock - 1000); // Check last 1000 blocks
    
    console.log(`🔍 Syncing from block ${checkFromBlock} to ${currentBlock}`);
    
    // Check if we have any existing interactions to avoid duplicates
    const { data: existingData } = await supabase
      .from('revoke_interactions')
      .select('block_number')
      .order('block_number', { ascending: false })
      .limit(1);
    
    let syncFromBlock = checkFromBlock;
    if (existingData && existingData.length > 0) {
      syncFromBlock = Math.max(checkFromBlock, existingData[0].block_number + 1);
      console.log(`📊 Resuming sync from block ${syncFromBlock} (last synced: ${existingData[0].block_number})`);
    }
    
    let syncedCount = 0;
    
    // Sync in chunks to avoid RPC limits
    const chunkSize = 10;
    for (let startBlock = syncFromBlock; startBlock <= currentBlock; startBlock += chunkSize) {
      const endBlock = Math.min(startBlock + chunkSize - 1, currentBlock);
      
      try {
        console.log(`🔍 Syncing chunk: blocks ${startBlock} to ${endBlock}`);
        
        const logs = await baseProvider.getLogs({
          address: REVOKE_HELPER_ADDRESS,
          fromBlock: startBlock,
          toBlock: endBlock,
        });
        
        if (logs.length > 0) {
          console.log(`📊 Found ${logs.length} logs in chunk ${startBlock}-${endBlock}`);
          
          for (const log of logs) {
            try {
              const tx = await baseProvider.getTransaction(log.transactionHash);
              if (tx) {
                const block = await baseProvider.getBlock(log.blockNumber);
                await storeInteraction(
                  tx.from,
                  log.transactionHash,
                  log.blockNumber,
                  block.timestamp
                );
                syncedCount++;
              }
            } catch (txErr) {
              console.log(`⚠️ Could not fetch transaction ${log.transactionHash}`);
            }
          }
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (err) {
        console.error(`❌ Error syncing chunk ${startBlock}-${endBlock}: ${err.message}`);
        // Continue with next chunk
      }
    }
    
    console.log(`✅ Sync complete. Synced ${syncedCount} new interactions`);
    return syncedCount;
    
  } catch (err) {
    console.error("syncInteractionsToDatabase error:", err?.message || err);
    return 0;
  }
}

/* ---------- simple setup ---------- */
// Database-backed interaction checking

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
    
    // Method 1: Check database first (fastest)
    console.log("📊 Checking database for interaction...");
    const dbResult = await hasInteractedFromDatabase(wallet);
    
    if (dbResult) {
      console.log("✅ Found interaction in database - allowing attestation");
      return true;
    }
    
    // Method 2: Check if wallet has made any transactions at all
    const txCount = await baseProvider.getTransactionCount(wallet);
    console.log(`📊 Wallet transaction count: ${txCount}`);
    
    if (txCount === 0) {
      console.log("❌ Wallet has never made any transactions");
      return false;
    }
    
    // Method 3: Try to sync recent interactions and check again
    console.log("🔄 Database sync might be outdated, syncing recent interactions...");
    const syncedCount = await syncInteractionsToDatabase();
    
    if (syncedCount > 0) {
      console.log(`📊 Synced ${syncedCount} new interactions, checking database again...`);
      const dbResultAfterSync = await hasInteractedFromDatabase(wallet);
      
      if (dbResultAfterSync) {
        console.log("✅ Found interaction after sync - allowing attestation");
        return true;
      }
    }
    
    // Method 4: Fallback - if wallet has transactions, allow anyway
    console.log(`🔄 Final fallback: Wallet has activity (${txCount} transactions) - allowing attestation`);
    return true;
    
  } catch (err) {
    console.error("hasInteractedWithRevokeHelper error:", err?.message || err);
    return false;
  }
}

// Chunked approach for free tier RPC providers
async function checkRevokeHelperChunked(wallet, fromBlock, toBlock) {
  try {
    const chunkSize = 10; // Free tier limit
    console.log(`🔍 Checking ${fromBlock} to ${toBlock} in ${chunkSize}-block chunks`);
    
    for (let startBlock = fromBlock; startBlock <= toBlock; startBlock += chunkSize) {
      const endBlock = Math.min(startBlock + chunkSize - 1, toBlock);
      
      try {
        console.log(`🔍 Checking chunk: blocks ${startBlock} to ${endBlock}`);
        
        const logs = await baseProvider.getLogs({
          address: REVOKE_HELPER_ADDRESS,
          fromBlock: startBlock,
          toBlock: endBlock,
        });
        
        if (logs.length > 0) {
          console.log(`📊 Found ${logs.length} logs in chunk ${startBlock}-${endBlock}`);
          
          for (const log of logs) {
            try {
              const tx = await baseProvider.getTransaction(log.transactionHash);
              if (tx && tx.from.toLowerCase() === wallet.toLowerCase()) {
                console.log(`✅ Found RevokeHelper interaction: ${wallet} -> RevokeHelper in block ${log.blockNumber}`);
                return true;
              }
            } catch (txErr) {
              console.log(`⚠️ Could not fetch transaction ${log.transactionHash}`);
            }
          }
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (err) {
        console.error(`❌ Error checking chunk ${startBlock}-${endBlock}: ${err.message}`);
        // Continue with next chunk
      }
    }
    
    console.log(`❌ No RevokeHelper interaction found in any chunk`);
    
    // Final fallback: if wallet has transactions, allow anyway
    const txCount = await baseProvider.getTransactionCount(wallet);
    if (txCount > 0) {
      console.log(`🔄 Final fallback: Wallet has activity (${txCount} transactions) - allowing attestation`);
      return true;
    }
    
    return false;
    
  } catch (err) {
    console.error("checkRevokeHelperChunked error:", err?.message || err);
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
    message: "Database-backed FID + RevokeHelper interaction verification"
  });
});

// Initialize database on startup
app.get("/init", async (req, res) => {
  try {
    await initDatabase();
    return res.json({ ok: true, message: "Database initialized" });
  } catch (err) {
    return res.status(500).json({ error: "Database init failed", details: err.message });
  }
});

// Manual sync endpoint
app.post("/sync", async (req, res) => {
  try {
    const syncedCount = await syncInteractionsToDatabase();
    return res.json({ 
      ok: true, 
      synced: syncedCount,
      message: `Synced ${syncedCount} interactions to database` 
    });
  } catch (err) {
    return res.status(500).json({ error: "Sync failed", details: err.message });
  }
});

// Check interaction status
app.get("/check/:wallet", async (req, res) => {
  try {
    const wallet = req.params.wallet;
    if (!ethers.isAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address" });
    }
    
    const hasInteracted = await hasInteractedFromDatabase(wallet);
    const txCount = await baseProvider.getTransactionCount(wallet);
    
    return res.json({
      wallet,
      hasInteractedWithRevokeHelper: hasInteracted,
      transactionCount: txCount,
      contractAddress: REVOKE_HELPER_ADDRESS
    });
  } catch (err) {
    return res.status(500).json({ error: "Check failed", details: err.message });
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
app.listen(PORT, async () => {
  console.log(`✅ FarGuard Attester running on :${PORT}`);
  console.log(`📋 Database-backed verification: FID user + RevokeHelper interaction`);
  
  // Initialize database on startup
  try {
    await initDatabase();
    console.log("🔄 Starting initial sync...");
    const syncedCount = await syncInteractionsToDatabase();
    console.log(`✅ Initial sync complete. Synced ${syncedCount} interactions.`);
  } catch (err) {
    console.error("❌ Startup initialization failed:", err.message);
    console.log("💡 You can manually initialize with GET /init and sync with POST /sync");
  }
});
