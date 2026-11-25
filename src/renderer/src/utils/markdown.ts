import MarkdownIt from 'markdown-it'

/**
 * Markdown from an AI, as safe HTML for `v-html`.
 *
 * Raw HTML in the text is shown as text, never run (`html: false`), and
 * markdown-it refuses `javascript:`, `vbscript:`, `file:` and `data:` links on
 * its own. Every link opens in the person's browser (`target="_blank"`, which
 * the main window hands to the system browser) instead of replacing the app.
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true
})

const renderToken: NonNullable<typeof md.renderer.rules.link_open> = (tokens, idx, options, _env, self) =>
  self.renderToken(tokens, idx, options)
const linkOpen = md.renderer.rules.link_open ?? renderToken
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return linkOpen(tokens, idx, options, env, self)
}

/**
 * Render Markdown content to safe HTML.
 * @param content - The raw markdown string.
 * @returns The rendered HTML string.
 */
export function renderMarkdown(content: string | null | undefined): string {
  if (!content) return ''
  return md.render(content)
}
