/**
 * Password hashing + initial password generation.
 *
 * - `hashPassword` / `verifyPassword`: argon2id with sensible defaults.
 *   The `argon2.verify` call is constant-time on the hash bytes (built-in),
 *   so this resists timing attacks as long as we don't leak which user was queried
 *   (the routes always return a generic 401, see auth.ts).
 *
 * - `generateInitialPassword`: 10-char password using an unambiguous alphabet.
 *   Same alphabet as page ids — no 0/o/1/i/l confusion. Users see this once
 *   when admin creates them and must reset on first login.
 *
 * Library: `@node-rs/argon2` — pure Rust, no node-gyp, ~10× faster than
 * the JS `argon2` package on hot paths. Returns the standard encoded hash
 * string `$argon2id$v=19$m=...,t=...,p=...$salt$hash`.
 */
import { hash, verify } from '@node-rs/argon2'
import { customAlphabet } from 'nanoid'

const INITIAL_PASSWORD_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz' // same as page id alphabet
const newInitialPassword = customAlphabet(INITIAL_PASSWORD_ALPHABET, 10)

/** Argon2id defaults — strong enough for an internal wiki but won't melt the CPU. */
const ARGON2_OPTS = {
  memoryCost: 19456, // 19 MiB — OWASP minimum for argon2id (2023)
  timeCost: 2,       // iterations
  parallelism: 1,
} as const

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTS)
}

export async function verifyPassword(plain: string, encodedHash: string): Promise<boolean> {
  try {
    return await verify(encodedHash, plain)
  } catch {
    // Malformed hash, wrong algorithm, etc. — treat as verification failure.
    return false
  }
}

/**
 * Generates a 10-char random password from the unambiguous alphabet.
 * Used for admin-created users; they must reset on first login.
 */
export function generateInitialPassword(): string {
  return newInitialPassword()
}
