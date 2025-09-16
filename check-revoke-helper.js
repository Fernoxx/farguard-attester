import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const REVOKE_HELPER_ADDRESS = "0x3acb4672fec377bd62cf4d9a0e6bdf5f10e5caaf";
const USER_WALLET = "0x3cF87B76d2A1D36F9542B4Da2a6B4B3Dc0f0Bb2e";
const TOKEN_ADDRESS = "0x4baea77ec672dec0fc311cca0eb45916e66a93a1";
const SPENDER_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

async function checkRevokeHelper() {
  try {
    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC);
    
    console.log("🔍 Checking RevokeHelper contract...");
    console.log("RevokeHelper address:", REVOKE_HELPER_ADDRESS);
    console.log("User wallet:", USER_WALLET);
    console.log("Token:", TOKEN_ADDRESS);
    console.log("Spender:", SPENDER_ADDRESS);
    
    // Try to call hasRevoked function
    try {
      const hasRevokedABI = [
        "function hasRevoked(address user, address token, address spender) external view returns (bool)"
      ];
      
      const revokeHelper = new ethers.Contract(REVOKE_HELPER_ADDRESS, hasRevokedABI, provider);
      const hasRevoked = await revokeHelper.hasRevoked(USER_WALLET, TOKEN_ADDRESS, SPENDER_ADDRESS);
      
      console.log("✅ hasRevoked result:", hasRevoked);
      
      if (hasRevoked) {
        console.log("✅ User has revoked this allowance in RevokeHelper");
      } else {
        console.log("❌ User has NOT revoked this allowance in RevokeHelper");
      }
      
    } catch (error) {
      console.log("❌ Error calling hasRevoked:", error.message);
      
      // Try to get contract code to see what functions are available
      const code = await provider.getCode(REVOKE_HELPER_ADDRESS);
      if (code === "0x") {
        console.log("❌ No contract found at this address");
      } else {
        console.log("✅ Contract exists at this address");
        console.log("Contract code length:", code.length);
      }
    }
    
  } catch (error) {
    console.error("Error:", error);
  }
}

checkRevokeHelper();