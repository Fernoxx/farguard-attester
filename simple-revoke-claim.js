// Simple function to automatically revoke and record
// Add this to your existing frontend code

const REVOKE_HELPER_ADDRESS = "0x3acb4672fec377bd62cf4d9a0e6bdf5f10e5caaf";
const REVOKE_HELPER_ABI = [
  "function recordRevoked(address token, address spender) external",
  "function hasRevoked(address wallet, address token, address spender) external view returns (bool)"
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)"
];

// Main function that does everything automatically
async function revokeAndClaim(userWallet, tokenAddress, spenderAddress, fid) {
  try {
    console.log("🚀 Starting revoke and claim process...");
    
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    
    // Step 1: Revoke the allowance
    console.log("📝 Step 1: Revoking allowance...");
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const revokeTx = await tokenContract.approve(spenderAddress, 0);
    await revokeTx.wait();
    console.log("✅ Allowance revoked successfully");
    
    // Step 2: Record the revocation in RevokeHelper
    console.log("📝 Step 2: Recording revocation...");
    const revokeHelper = new ethers.Contract(REVOKE_HELPER_ADDRESS, REVOKE_HELPER_ABI, signer);
    const recordTx = await revokeHelper.recordRevoked(tokenAddress, spenderAddress);
    await recordTx.wait();
    console.log("✅ Revocation recorded successfully");
    
    // Step 3: Get attestation from your server
    console.log("📝 Step 3: Getting attestation...");
    const attestationResponse = await fetch('https://farguard-attester-production.up.railway.app/attest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: userWallet,
        token: tokenAddress,
        spender: spenderAddress
      })
    });
    
    if (!attestationResponse.ok) {
      throw new Error(`Attestation failed: ${attestationResponse.statusText}`);
    }
    
    const attestation = await attestationResponse.json();
    console.log("✅ Attestation received");
    
    // Step 4: Claim rewards from RevokeAndClaim contract
    console.log("📝 Step 4: Claiming rewards...");
    const REVOKE_AND_CLAIM_ADDRESS = "YOUR_REVOKE_AND_CLAIM_CONTRACT_ADDRESS"; // Replace with your actual address
    const REVOKE_AND_CLAIM_ABI = [
      "function claimWithAttestation(uint256 fid, uint256 nonce, uint256 deadline, address token, address spender, bytes calldata signature) external"
    ];
    
    const revokeAndClaim = new ethers.Contract(REVOKE_AND_CLAIM_ADDRESS, REVOKE_AND_CLAIM_ABI, signer);
    const claimTx = await revokeAndClaim.claimWithAttestation(
      attestation.fid,
      attestation.nonce,
      attestation.deadline,
      tokenAddress,
      spenderAddress,
      attestation.sig
    );
    
    await claimTx.wait();
    console.log("✅ Rewards claimed successfully!");
    
    return { success: true, message: "Revoke and claim completed successfully!" };
    
  } catch (error) {
    console.error("❌ Revoke and claim failed:", error);
    return { success: false, error: error.message };
  }
}

// Helper function to check if user has already revoked
async function checkIfRevoked(userWallet, tokenAddress, spenderAddress) {
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const revokeHelper = new ethers.Contract(REVOKE_HELPER_ADDRESS, REVOKE_HELPER_ABI, provider);
    
    const hasRevoked = await revokeHelper.hasRevoked(userWallet, tokenAddress, spenderAddress);
    return hasRevoked;
  } catch (error) {
    console.error("Failed to check revocation status:", error);
    return false;
  }
}

// Usage example:
// const result = await revokeAndClaim(
//   "0x3cF87B76d2A1D36F9542B4Da2a6B4B3Dc0f0Bb2e", // user wallet
//   "0x4baea77ec672dec0fc311cca0eb45916e66a93a1", // token address
//   "0x000000000022D473030F116dDEE9F6B43aC78BA3", // spender (Permit2)
//   242597 // fid
// );