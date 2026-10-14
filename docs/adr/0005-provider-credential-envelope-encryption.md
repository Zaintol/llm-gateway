# 5. Envelope-encrypt provider credentials with a versioned master key

- Status: accepted
- Date: 2026-10-14

## Context and problem statement

The gateway stores tenants' provider API keys so application teams never handle them. A database
dump or backup must not expose them, master keys must be rotatable without downtime, and a cloud
KMS should be an option later without rewriting storage.

## Considered options

- Plaintext columns protected by database access control
- Encrypt each secret directly with the master key
- Envelope encryption: a data key per credential, wrapped by a versioned master key

## Decision outcome

Chosen: **envelope encryption**. Each credential gets a fresh 256-bit data key and AES-256-GCM,
with additional authenticated data binding the ciphertext to its tenant and provider. The data key
is wrapped by the master key from `GATEWAY_MASTER_KEY`, recorded with its version. Rotation adds
the old key to `GATEWAY_PREVIOUS_MASTER_KEYS` and runs `credentials:reencrypt`, which re-wraps
data keys only. A `KeyProvider` interface isolates the master key, so a KMS can implement it.

## Consequences

- Good: dumps contain only ciphertext; rows copied to another tenant fail to decrypt.
- Good: rotation re-wraps small data keys instead of re-encrypting every secret.
- Bad: the gateway cannot start without the master key, and losing it loses every credential.
- Bad: decrypted secrets are cached in memory for five minutes to keep the hot path fast.
