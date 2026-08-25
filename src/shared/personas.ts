/**
 * The persona every project falls back to.
 *
 * Lives in shared because BOTH processes need it and they used to declare it
 * separately — main's constants/personas.ts and the renderer's editorStore —
 * with the renderer's copy winning in runPrompt. Two hardcoded strings that
 * must agree is a footgun; this is the one definition.
 *
 * `general-editor` is deliberately the least opinionated built-in: with persona
 * modes gone the prompt carries all the intent, so the default should add as
 * little bias as possible.
 */
export const DEFAULT_PERSONA_ID = 'general-editor'
