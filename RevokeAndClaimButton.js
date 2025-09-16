import React, { useState } from 'react';
import { ethers } from 'ethers';

// Contract addresses
const REVOKE_HELPER_ADDRESS = "0x3acb4672fec377bd62cf4d9a0e6bdf5f10e5caaf";
const REVOKE_AND_CLAIM_ADDRESS = "0x..."; // Your RevokeAndClaim contract address

// Contract ABIs
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)"
];

const REVOKE_HELPER_ABI = [
  "function recordRevoked(address token, address spender) external",
  "function hasRevoked(address wallet, address token, address spender) external view returns (bool)"
];

const REVOKE_AND_CLAIM_ABI = [
  "function claimWithAttestation(uint256 fid, uint256 nonce, uint256 deadline, address token, address spender, bytes calldata signature) external"
];

export default function RevokeAndClaimButton({ 
  userWallet, 
  tokenAddress, 
  spenderAddress, 
  fid,
  onSuccess 
}) {
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState('ready'); // ready, revoking, recording, claiming, success
  const [error, setError] = useState(null);

  // Step 1: Revoke allowance on token contract
  const revokeAllowance = async () => {
    try {
      setStep('revoking');
      setError(null);

      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
      
      // Revoke the allowance (set to 0)
      const tx = await tokenContract.approve(spenderAddress, 0);
      await tx.wait();
      
      console.log("✅ Allowance revoked successfully");
      return true;
    } catch (err) {
      console.error("❌ Failed to revoke allowance:", err);
      setError(`Failed to revoke allowance: ${err.message}`);
      return false;
    }
  };

  // Step 2: Record revocation in RevokeHelper
  const recordRevocation = async () => {
    try {
      setStep('recording');
      setError(null);

      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      
      const revokeHelper = new ethers.Contract(REVOKE_HELPER_ADDRESS, REVOKE_HELPER_ABI, signer);
      
      // Record the revocation
      const tx = await revokeHelper.recordRevoked(tokenAddress, spenderAddress);
      await tx.wait();
      
      console.log("✅ Revocation recorded successfully");
      return true;
    } catch (err) {
      console.error("❌ Failed to record revocation:", err);
      setError(`Failed to record revocation: ${err.message}`);
      return false;
    }
  };

  // Step 3: Get attestation from your server
  const getAttestation = async () => {
    try {
      setStep('getting_attestation');
      setError(null);

      const response = await fetch('https://farguard-attester-production.up.railway.app/attest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          wallet: userWallet,
          token: tokenAddress,
          spender: spenderAddress
        })
      });

      if (!response.ok) {
        throw new Error(`Attestation failed: ${response.statusText}`);
      }

      const attestation = await response.json();
      console.log("✅ Attestation received:", attestation);
      return attestation;
    } catch (err) {
      console.error("❌ Failed to get attestation:", err);
      setError(`Failed to get attestation: ${err.message}`);
      return null;
    }
  };

  // Step 4: Claim rewards from RevokeAndClaim contract
  const claimRewards = async (attestation) => {
    try {
      setStep('claiming');
      setError(null);

      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      
      const revokeAndClaim = new ethers.Contract(REVOKE_AND_CLAIM_ADDRESS, REVOKE_AND_CLAIM_ABI, signer);
      
      // Call claimWithAttestation with the attestation data
      const tx = await revokeAndClaim.claimWithAttestation(
        attestation.fid,
        attestation.nonce,
        attestation.deadline,
        tokenAddress,
        spenderAddress,
        attestation.sig
      );
      
      await tx.wait();
      
      console.log("✅ Rewards claimed successfully");
      setStep('success');
      onSuccess && onSuccess();
      return true;
    } catch (err) {
      console.error("❌ Failed to claim rewards:", err);
      setError(`Failed to claim rewards: ${err.message}`);
      return false;
    }
  };

  // Main function that does all steps automatically
  const handleRevokeAndClaim = async () => {
    setLoading(true);
    setError(null);

    try {
      // Step 1: Revoke allowance
      const revoked = await revokeAllowance();
      if (!revoked) return;

      // Step 2: Record revocation
      const recorded = await recordRevocation();
      if (!recorded) return;

      // Step 3: Get attestation
      const attestation = await getAttestation();
      if (!attestation) return;

      // Step 4: Claim rewards
      await claimRewards(attestation);

    } catch (err) {
      console.error("❌ Revoke and claim failed:", err);
      setError(`Revoke and claim failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Check if user has already revoked and recorded
  const checkRevocationStatus = async () => {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const revokeHelper = new ethers.Contract(REVOKE_HELPER_ADDRESS, REVOKE_HELPER_ABI, provider);
      
      const hasRevoked = await revokeHelper.hasRevoked(userWallet, tokenAddress, spenderAddress);
      return hasRevoked;
    } catch (err) {
      console.error("Failed to check revocation status:", err);
      return false;
    }
  };

  const getButtonText = () => {
    switch (step) {
      case 'revoking': return 'Revoking Allowance...';
      case 'recording': return 'Recording Revocation...';
      case 'getting_attestation': return 'Getting Attestation...';
      case 'claiming': return 'Claiming Rewards...';
      case 'success': return 'Success! ✅';
      default: return 'Revoke & Claim Rewards';
    }
  };

  return (
    <div className="revoke-claim-container">
      <button 
        onClick={handleRevokeAndClaim}
        disabled={loading || step === 'success'}
        className="revoke-claim-button"
      >
        {getButtonText()}
      </button>
      
      {error && (
        <div className="error-message">
          ❌ {error}
        </div>
      )}
      
      {step === 'success' && (
        <div className="success-message">
          ✅ Successfully revoked allowance and claimed rewards!
        </div>
      )}
    </div>
  );
}