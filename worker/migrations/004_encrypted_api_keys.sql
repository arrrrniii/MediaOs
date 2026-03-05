-- Add encrypted_key column to api_keys for key reveal feature
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS encrypted_key TEXT;
