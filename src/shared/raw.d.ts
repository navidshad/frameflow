/** Vite's `?raw` suffix: the file's text as a string. Used for bundled motion pages. */
declare module '*?raw' {
	const content: string
	export default content
}
