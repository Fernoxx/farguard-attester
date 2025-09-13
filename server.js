import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { ethers } from "ethers";
import pkg from "@neynar/nodejs-sdk";
const { NeynarAPIClient } = pkg;

// ✅ Only one declaration
const neynarClient = new NeynarAPIClient({
  apiKey: process.env.NEYNAR_API_KEY,
});

dotenv.config();

const PORT = process.env.PORT || 3000;
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const NEYNAR_RPC = process.env.NEYNAR_RPC || "https://snapchain-api.neynar.com";
const ATTESTER_PK = process.env.ATTESTER_PK;
const VERIFYING_CONTRACT = process.env.VERIFYING_CONTRACT;
const REVOKE_HELPER_ADDRESS = process.env.REVOKE_HELPER_ADDRESS;
const CHAIN_ID = Number(process.env.CHAIN_ID || 8453);

if (!NEYNAR_API_KEY) {
  console.error("NEYNAR_API_KEY missing");
  process.exit(1);
}
if (!ATTESTER_PK) {
  console.error("ATTESTER_PK missing");
  process.exit(1);
}
if (!VERIFYING_CONTRACT || !REVOKE_HELPER_ADDRESS) {
  console.error("contract addresses missing in env");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(cors());
app.use(helmet());

// trust proxy for rate limiting (Railway/Heroku/Vercel issue)
app.set("trust proxy", 1);

app.use(
  rateLimit({
    windowMs: 60_000,
    max: 60, // adjust as needed
    message: { error: "Too many requests, slow down" },
  })
);

// attester signer (only for signing attestations)
const attesterWallet = new ethers.Wallet(ATTESTER_PK);

// EIP-712 config (must match on-chain domain values)
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

/**
 * Uses Neynar SDK exact endpoint per docs:
 * fetchBulkUsersByEthOrSolAddress
 * Some SDK versions expose it directly, some under .v2
 */
async function fetchFarcasterUserByWallet(walletAddress) {
  const addresses = [ethers.getAddress(walletAddress)];

  let resp = null;

  try {
    if (typeof neynarClient.fetchBulkUsersByEthOrSolAddress === "function") {
      resp = await neynarClient.fetchBulkUsersByEthOrSolAddress({ addresses });
    } else if (
      neynarClient.v2 &&
      typeof neynarClient.v2.fetchBulkUsersByEthOrSolAddress === "function"
    ) {
      resp = await neynarClient.v2.fetchBulkUsersByEthOrSolAddress({ addresses });
    } else {
      console.error("Neynar SDK: fetchBulkUsersByEthOrSolAddress not found in client");
      return null;
    }
  } catch (err) {
    console.error("Neynar fetch error:", err);
    return null;
  }

  if (!resp) return null;

  // handle shape differences
  if (resp.result && resp.result.user) return resp.result.user;
  if (resp.result && Array.isArray(resp.result.users)) {
    return resp.result.users[0]; // take the first user if array
  }
  if (Array.isArray(resp) && resp[0]?.result?.user) return resp[0].result.user;

  return null;
}

/**
 * Check on-chain RevokeHelper logs via Neynar Snapchain RPC (eth_getLogs)
 */
async function hasRevokedRecordedOnchain(wallet, token, spender) {
  try {
    const eventTopic = ethers.id("Revoked(address,address,address)");
    const topics = [
      eventTopic,
      ethers.hexZeroPad(ethers.getAddress(wallet), 32),
      token ? ethers.hexZeroPad(ethers.getAddress(token), 32) : null,
      spender ? ethers.hexZeroPad(ethers.getAddress(spender), 32) : null,
    ];

    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [
        {
          address: REVOKE_HELPER_ADDRESS,
          topics,
          fromBlock: "0x0",
          toBlock: "latest",
        },
      ],
    };

    const res = await axios.post(NEYNAR_RPC, payload, {
      headers: { "Content-Type": "application/json", "x-api-key": NEYNAR_API_KEY },
      timeout: 15000,
    });

    const logs = res?.data?.result;
    return Array.isArray(logs) && logs.length > 0;
  } catch (err) {
    console.error("hasRevokedRecordedOnchain error:", err?.message || err);
    throw err;
  }
}

/* ------------------ endpoints ------------------ */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    attester: attesterWallet.address,
  });
});

app.post("/checkRevoked", async (req, res) => {
  try {
    const { wallet, token, spender } = req.body;
    if (!wallet || !token || !spender) return res.status(400).json({ error: "wallet, token, spender required" });
    const revoked = await hasRevokedRecordedOnchain(wallet, token, spender);
    return res.json({ revoked });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "internal error", details: err?.message || String(err) });
  }
});

app.post("/attest", async (req, res) => {
  try {
    const { wallet, token = ethers.ZeroAddress, spender = ethers.ZeroAddress } = req.body;
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    // 1) verify Farcaster user via Neynar SDK
    const user = await fetchFarcasterUserByWallet(wallet);
    if (!user) {
      return res.status(403).json({ error: "wallet not a Farcaster user" });
    }
    const fid = String(user.fid);

    // 2) check revoke recorded
    const revoked = await hasRevokedRecordedOnchain(wallet, token, spender);
    if (!revoked) {
      return res.status(400).json({ error: "no revoke recorded onchain; call recordRevoked first" });
    }

    // 3) build attestation and sign
    const nonce = BigInt(Date.now()).toString();
    const deadline = Math.floor(Date.now() / 1000) + 10 * 60; // 10 min TTL

    const domain = buildDomain();
    const value = {
      wallet: ethers.getAddress(wallet),
      fid,
      nonce,
      deadline,
      token: token ? ethers.getAddress(token) : ethers.ZeroAddress,
      spender: spender ? ethers.getAddress(spender) : ethers.ZeroAddress,
    };

    const signature = await attesterWallet._signTypedData(domain, ATTEST_TYPES, value);

    return res.json({
      sig: signature,
      nonce,
      deadline,
      fid,
      issuedBy: attesterWallet.address,
    });
  } catch (err) {
    console.error("attest error:", err?.message || err);
    return res.status(500).json({ error: "internal error", details: err?.message || String(err) });
  }
});

/* ------------------ start ------------------ */
app.listen(PORT, () => {
  console.log(`Attester running on port ${PORT}. attester=${attesterWallet.address}`);
});
