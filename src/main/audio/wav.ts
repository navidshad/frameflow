/** A 16-bit PCM WAV: the 44-byte header, then the samples. */
export function wavFromPcm16(samples: Buffer | Int16Array, sampleRate: number, channels: number): Buffer {
	const data = Buffer.isBuffer(samples) ? samples : Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
	const header = Buffer.alloc(44)
	header.write('RIFF', 0)
	header.writeUInt32LE(36 + data.length, 4)
	header.write('WAVEfmt ', 8)
	header.writeUInt32LE(16, 16)
	header.writeUInt16LE(1, 20)
	header.writeUInt16LE(channels, 22)
	header.writeUInt32LE(sampleRate, 24)
	header.writeUInt32LE(sampleRate * channels * 2, 28)
	header.writeUInt16LE(channels * 2, 32)
	header.writeUInt16LE(16, 34)
	header.write('data', 36)
	header.writeUInt32LE(data.length, 40)
	return Buffer.concat([header, data])
}
