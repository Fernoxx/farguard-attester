-- Create the revoke_interactions table
CREATE TABLE IF NOT EXISTS revoke_interactions (
    id SERIAL PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    transaction_hash TEXT NOT NULL UNIQUE,
    block_number INTEGER NOT NULL,
    block_timestamp INTEGER NOT NULL,
    contract_address TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Indexes for better performance
    INDEX idx_wallet_address (wallet_address),
    INDEX idx_block_number (block_number),
    INDEX idx_contract_address (contract_address),
    INDEX idx_created_at (created_at)
);

-- Create a function to create the table if it doesn't exist (for RPC calls)
CREATE OR REPLACE FUNCTION create_interactions_table_if_not_exists()
RETURNS TEXT AS $$
BEGIN
    -- Table creation is handled above, this function is just for RPC calls
    RETURN 'Table revoke_interactions is ready';
END;
$$ LANGUAGE plpgsql;

-- Grant necessary permissions (adjust as needed for your Supabase setup)
-- GRANT ALL ON TABLE revoke_interactions TO authenticated;
-- GRANT ALL ON TABLE revoke_interactions TO anon;