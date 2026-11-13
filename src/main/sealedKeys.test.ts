import { describe, expect, it } from 'vitest'
import { openKey, storeKey, type KeyCrypto } from './sealedKeys'

/** A keychain that belongs to one app name: it reads only what it wrote. */
const keychain = (name: string, available = true): KeyCrypto => ({
	available: () => available,
	encrypt: (value) => `${name}:${value}`,
	decrypt: (ciphertext) => {
		if (!ciphertext.startsWith(`${name}:`)) throw new Error('not ours')
		return ciphertext.slice(name.length + 1)
	}
})

describe('a secret encrypted at rest', () => {
	it('reads back what the same app wrote', () => {
		const app = keychain('frameflow')
		const stored = storeKey({ value: 'secret' }, app)
		expect(stored).toEqual({ enc: 'frameflow:secret' })
		expect(openKey(stored, app)).toEqual({ value: 'secret' })
	})

	it('keeps a ciphertext it cannot read and writes it back untouched', () => {
		const stored = storeKey({ value: 'secret' }, keychain('frameflow'))
		const other = keychain('Electron')
		const opened = openKey(stored, other)
		expect(opened).toEqual({ sealed: 'frameflow:secret' })
		// The launch that could not read it saves the settings; the first app still finds its key.
		const rewritten = storeKey(opened, other)
		expect(openKey(rewritten, keychain('frameflow'))).toEqual({ value: 'secret' })
	})

	it('says so when a ciphertext cannot be read', () => {
		const errors: unknown[] = []
		openKey({ enc: 'frameflow:secret' }, keychain('Electron'), (e) => errors.push(e))
		expect(errors).toHaveLength(1)
	})

	it('lets a new value replace a sealed one', () => {
		const other = keychain('Electron')
		const opened = openKey({ enc: 'frameflow:old' }, other)
		expect(storeKey({ ...opened, value: 'new' }, other)).toEqual({ enc: 'Electron:new' })
	})

	it('writes nothing for a secret that was never set', () => {
		expect(storeKey({}, keychain('frameflow'))).toEqual({})
		expect(openKey({}, keychain('frameflow'))).toEqual({ value: undefined })
	})

	it('falls back to plain text where the OS cannot encrypt, and reads that back', () => {
		const none = keychain('frameflow', false)
		const stored = storeKey({ value: 'secret' }, none)
		expect(stored).toEqual({ plain: 'secret' })
		expect(openKey(stored, none)).toEqual({ value: 'secret' })
	})
})
