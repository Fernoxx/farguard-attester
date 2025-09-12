import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { ethers } from "ethers";
import { NeynarAPIClient, Configuration } from "@neynar/nodejs-sdk";
import axios from "axios";

dotenv.config();

const PORT = process.env.PORT || 3000;
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const NEYNAR_RPC = process.env.NEYNAR_RPC || "https://snapchain-api.neynar.com";
const ATTESTER_PK = process.env.ATTESTER_PK;
const RELAYER_PK = process.env.RELAYER_PK || null;
const VERIFYING_CONTRACT = process.env.VERIFYING_CONTRACT;
const REVOKE_HELPER_ADDRESS = process.env.REVOKE_HELPER_ADDRESS;
const CHAIN_ID = Number(process.env.CHAIN_ID || 8453);
const RPC_HTTP = process.env.RPC_HTTP || null;

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
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 60, // adjust to your needs
    message: { error: "Too many requests, slow down" },
  })
);

// initialize neynar SDK client (exact call from docs)
const neynarConfig = new Configuration({
  apiKey: NEYNAR_API_KEY,
});
const neynarClient = new NeynarAPIClient(neynarConfig);

// ethers signers
const attesterWallet = new ethers.Wallet(ATTESTER_PK);
let relayerWallet = null;
let relayerProvider = null;
if (RELAYER_PK && RPC_HTTP) {
  relayerProvider = new ethers.JsonRpcProvider(RPC_HTTP, { name: "base", chainId: CHAIN_ID });
  relayerWallet = new ethers.Wallet(RELAYER_PK, relayerProvider);
}

// EIP-712 domain
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
 * client.fetchBulkUsersByEthOrSolAddress({ addresses: [addr] })
 * returns user object under res.result.user if exists.
 */
async function fetchFarcasterUserByWallet(walletAddress) {
  const addresses = [ethers.getAddress(walletAddress)];
  // exact SDK method from Neynar docs:
  const resp = await neynarClient.fetchBulkUsersByEthOrSolAddress({ addresses });
  // resp shape: { result: { user: { fid: ..., ... } } } per docs
  // some SDKs wrap differently; adjust if you see resp.data or resp.result.user
  if (!resp) return null;
  // defensive checks:
  if (resp.result && resp.result.user) return resp.result.user;
  // sometimes SDK returns an array; try fallback:
  if (Array.isArray(resp)) {
    // try first element
    const first = resp[0];
    if (first && first.result && first.result.user) return first.result.user;
  }
  return null;
}

/**
 * Optional: check on-chain logs on the RevokeHelper contract using Neynar RPC (eth_getLogs).
 * This avoids signing attestations when there's no on-chain record.
 */
async function hasRevokedRecordedOnchain(wallet, token, spender) {
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
}

/* ------------------ endpoints ------------------ */

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    attester: attesterWallet.address,
    relayer: relayerWallet ? relayerWallet.address : null,
  });
});

/**
 * Attest endpoint
 * Body: { wallet, token, spender }
 * Response: { sig, nonce, deadline, fid }
 */
app.post("/attest", async (req, res) => {
  try {
    const { wallet, token = ethers.ZeroAddress, spender = ethers.ZeroAddress } = req.body;
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    // 1) verify Farcaster user via Neynar SDK exact call
    const user = await fetchFarcasterUserByWallet(wallet);
    if (!user) {
      return res.status(403).json({ error: "wallet not a Farcaster user" });
    }
    const fid = String(user.fid);

    // 2) optional: verify revoke recorded onchain - saves attestations for invalid attempts
    const revoked = await hasRevokedRecordedOnchain(wallet, token, spender);
    if (!revoked) {
      return res.status(400).json({ error: "no revoke recorded onchain; call recordRevoked first" });
    }

    // 3) build attestation and sign
    const nonce = BigInt(Date.now()).toString();
    const deadline = Math.floor(Date.now() / 1000) + 10 * 60; // 10 minutes TTL

    const domain = buildDomain();
    const value = {
      wallet: ethers.getAddress(wallet),
      fid,
      nonce,
      deadline,
      token: token ? ethers.getAddress(token) : ethers.ZeroAddress,
      spender: spender ? ethers.getAddress(spender) : ethers.ZeroAddress,
    };

    // ethers v6: _signTypedData(domain, types, value)
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

/**
 * checkRevoked - quick check if user's revoke recorded (callable by frontend to pre-check)
 * Body: { wallet, token, spender }
 */
app.post("/checkRevoked", async (req, res) => {
  try {
    const { wallet, token, spender } = req.body;
    if (!wallet || !token || !spender) return res.status(400).json({ error: "wallet, token, spender required" });
    const revoked = await hasRevokedRecordedOnchain(wallet, token, spender);
    return res.json({ revoked });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "internal error" });
  }
});

/* ------------------ admin relayer endpoints (OPTIONAL) ------------------ */
/**
 * POST /admin/migrate
 * Body: { action: "migrateToNew" | "rescueERC20", params: [...] }
 * Requires RELAYER_PK and RPC_HTTP configured. Use with extreme caution.
 */
app.post("/admin/migrate", async (req, res) => {
  if (!relayerWallet) return res.status(403).json({ error: "relayer not configured" });

  // very simple auth: require attester address to match OR you can add a secret header
  // In production, protect this endpoint more thoroughly (IP allowlist, API key, etc.)
  const apiKey = req.headers["x-admin-key"];
  if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) return res.status(403).json({ error: "not authorized" });

  const { action, params } = req.body;
  if (!action) return res.status(400).json({ error: "action required" });

  try {
    // we need the ABI for your RevokeAndClaim's methods
    const abi = [
      "function migrateToNew(address newContract)",
      "function rescueERC20(address token, address to, uint256 amount)"
    ];
    const contract = new ethers.Contract(VERIFYING_CONTRACT, abi, relayerWallet);

    let tx;
    if (action === "migrateToNew") {
      const [newContract] = params;
      tx = await contract.migrateToNew(newContract);
    } else if (action === "rescueERC20") {
      const [token, to, amount] = params;
      tx = await contract.rescueERC20(token, to, amount);
    } else {
      return res.status(400).json({ error: "unsupported action" });
    }

    const receipt = await tx.wait();
    return res.json({ txHash: receipt.transactionHash, receipt });
  } catch (err) {
    console.error("admin migrate failed", err);
    return res.status(500).json({ error: "tx failed", details: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Attester running on port ${PORT}. attester=${attesterWallet.address} relayer=${relayerWallet ? relayerWallet.address : "none"}`);
});
