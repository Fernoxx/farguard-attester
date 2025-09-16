# Frontend Update Guide: Auto Record Revocations

## 🎯 **What You Need to Change:**

Your current frontend probably only does this:
```javascript
// Current code (incomplete)
const revokeTx = await tokenContract.approve(spender, 0);
```

## ✅ **Updated Code (Complete):**

Replace your current revoke function with this:

```javascript
// Updated code (complete)
async function revokeAndRecord(userWallet, tokenAddress, spenderAddress) {
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    
    // Step 1: Revoke the allowance
    console.log("Revoking allowance...");
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const revokeTx = await tokenContract.approve(spenderAddress, 0);
    await revokeTx.wait();
    console.log("✅ Allowance revoked");
    
    // Step 2: Record the revocation in RevokeHelper
    console.log("Recording revocation...");
    const REVOKE_HELPER_ADDRESS = "0x3acb4672fec377bd62cf4d9a0e6bdf5f10e5caaf";
    const REVOKE_HELPER_ABI = [
      "function recordRevoked(address token, address spender) external"
    ];
    
    const revokeHelper = new ethers.Contract(REVOKE_HELPER_ADDRESS, REVOKE_HELPER_ABI, signer);
    const recordTx = await revokeHelper.recordRevoked(tokenAddress, spenderAddress);
    await recordTx.wait();
    console.log("✅ Revocation recorded");
    
    return { success: true };
  } catch (error) {
    console.error("Revoke failed:", error);
    return { success: false, error: error.message };
  }
}
```

## 🔧 **Step-by-Step Integration:**

### **1. Find Your Current Revoke Function**
Look for code like:
- `tokenContract.approve(spender, 0)`
- `approve(spender, 0)`
- Any function that revokes allowances

### **2. Add RevokeHelper Contract**
Add these constants at the top of your file:
```javascript
const REVOKE_HELPER_ADDRESS = "0x3acb4672fec377bd62cf4d9a0e6bdf5f10e5caaf";
const REVOKE_HELPER_ABI = [
  "function recordRevoked(address token, address spender) external"
];
```

### **3. Update Your Revoke Function**
Replace your current revoke logic with the updated code above.

### **4. Update Your Button/UI**
Make sure your button calls the new function:
```javascript
const handleRevoke = async () => {
  setLoading(true);
  const result = await revokeAndRecord(userWallet, tokenAddress, spenderAddress);
  setLoading(false);
  
  if (result.success) {
    // Show success message
    // Enable claim button
  } else {
    // Show error message
  }
};
```

## 📋 **Complete Example:**

```javascript
import { ethers } from 'ethers';

const REVOKE_HELPER_ADDRESS = "0x3acb4672fec377bd62cf4d9a0e6bdf5f10e5caaf";
const REVOKE_HELPER_ABI = [
  "function recordRevoked(address token, address spender) external"
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)"
];

export default function RevokeButton({ userWallet, tokenAddress, spenderAddress }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleRevoke = async () => {
    setLoading(true);
    setError(null);

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      
      // Step 1: Revoke allowance
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
      const revokeTx = await tokenContract.approve(spenderAddress, 0);
      await revokeTx.wait();
      
      // Step 2: Record revocation
      const revokeHelper = new ethers.Contract(REVOKE_HELPER_ADDRESS, REVOKE_HELPER_ABI, signer);
      const recordTx = await revokeHelper.recordRevoked(tokenAddress, spenderAddress);
      await recordTx.wait();
      
      console.log("✅ Revoked and recorded successfully!");
      
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button onClick={handleRevoke} disabled={loading}>
      {loading ? 'Revoking...' : 'Revoke Allowance'}
    </button>
  );
}
```

## 🚀 **Benefits:**

- ✅ **Users don't need to do extra steps**
- ✅ **Automatic recording in RevokeHelper**
- ✅ **Your RevokeAndClaim contract will work**
- ✅ **All users get properly recorded**

## 🔍 **Testing:**

After updating, test with:
1. Revoke an allowance
2. Check: `https://farguard-attester-production.up.railway.app/check-revoke-helper/YOUR_WALLET/TOKEN_ADDRESS/SPENDER_ADDRESS`
3. Should return `hasRevoked: true`
4. Then try claiming rewards