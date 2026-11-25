import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('an AI’s markdown in the chat', () => {
	it('renders what assistants write: emphasis, lists, code, headings', () => {
		const html = renderMarkdown('## Done\n\nI **trimmed** the intro:\n\n- cut 0:02–0:05\n- added `addSounds`\n\n```\napply_ops\n```')
		expect(html).toContain('<h2>Done</h2>')
		expect(html).toContain('<strong>trimmed</strong>')
		expect(html).toContain('<li>cut 0:02–0:05</li>')
		expect(html).toContain('<code>addSounds</code>')
		expect(html).toContain('<pre><code>apply_ops\n</code></pre>')
	})

	it('keeps single line breaks, as chat text has them', () => {
		expect(renderMarkdown('one\ntwo')).toBe('<p>one<br>\ntwo</p>\n')
	})

	it('shows raw HTML as text and never runs it', () => {
		const html = renderMarkdown('<img src=x onerror="alert(1)"> <script>steal()</script>')
		expect(html).not.toContain('<img')
		expect(html).not.toContain('<script')
		expect(html).toContain('&lt;script&gt;')
	})

	it('opens every link in the browser, and refuses script links', () => {
		const html = renderMarkdown('See [the docs](https://elevenlabs.io/docs) or https://example.com')
		expect(html).toContain('<a href="https://elevenlabs.io/docs" target="_blank" rel="noopener noreferrer">the docs</a>')
		expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>')
		expect(renderMarkdown('[click](javascript:alert(1))')).not.toContain('href="javascript')
	})

	it('is empty for nothing', () => {
		expect(renderMarkdown('')).toBe('')
		expect(renderMarkdown(undefined)).toBe('')
	})
})
