/**
 * Is there text selected on the page, the kind a person means to copy?
 *
 * The editor's Cmd+C copies the selected clips. With a clip selected AND a
 * message selected in the chat, that shortcut won and swallowed the key, so the
 * text could never be copied. A selection of words is what was just done, so
 * the browser's own copy gets the key. A collapsed caret, or only whitespace,
 * is not a selection of anything.
 */
export function textIsSelected(selection: Pick<Selection, 'isCollapsed' | 'toString'> | null | undefined): boolean {
	if (!selection || selection.isCollapsed) return false
	return selection.toString().trim().length > 0
}
