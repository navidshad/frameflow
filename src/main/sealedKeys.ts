/**
 * Reading and writing a secret that is encrypted at rest, without ever losing
 * one that cannot be read right now.
 *
 * The OS encrypts with a key that belongs to the APP'S NAME (on macOS the
 * keychain item is "<name> Safe Storage"). A launch under another name, a
 * restored backup or a keychain that is locked cannot decrypt what an earlier
 * launch wrote. The settings file is rewritten on start, and writing it back
 * without the secret it failed to read erased the user's API key: the next
 * launch under the right name found nothing to decrypt.
 *
 * So a ciphertext that cannot be read is kept, exactly as it was ("sealed"),
 * and written back until a new value replaces it. No Electron here: the
 * encryption is passed in, so this is tested without a keychain.
 */

export interface KeyCrypto {
	available(): boolean
	/** Base64 ciphertext. */
	encrypt(value: string): string
	/** Throws when the ciphertext is not this launch's to read. */
	decrypt(ciphertext: string): string
}

export interface OpenedKey {
	value?: string
	/** The ciphertext as stored, when it could not be read. */
	sealed?: string
}

export function openKey(stored: { enc?: string; plain?: string }, crypto: KeyCrypto, onUnreadable?: (error: unknown) => void): OpenedKey {
	if (stored.enc) {
		try {
			return { value: crypto.decrypt(stored.enc) }
		} catch (error) {
			onUnreadable?.(error)
			return { sealed: stored.enc }
		}
	}
	return { value: stored.plain }
}

/**
 * What to write for a secret: a value is encrypted (in plain text only where
 * the OS cannot encrypt); with no value, a sealed ciphertext is written back
 * untouched.
 */
export function storeKey(key: OpenedKey, crypto: KeyCrypto, onPlain?: (error: unknown) => void): { enc?: string; plain?: string } {
	if (!key.value) return key.sealed ? { enc: key.sealed } : {}
	try {
		if (crypto.available()) return { enc: crypto.encrypt(key.value) }
	} catch (error) {
		onPlain?.(error)
	}
	return { plain: key.value }
}
