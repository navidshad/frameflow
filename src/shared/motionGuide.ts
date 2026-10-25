/**
 * How to WRITE a motion page well — for the AI and for agents over MCP.
 *
 * The contract (what a page may and may not do) is enforced: a page that breaks
 * it is not drawn, and the result says why. Craft cannot be enforced, so it is
 * written down here once and read from here by every author: the `get_motion_guide`
 * tool, the built-in editor's instructions and the engine prompt.
 *
 * Each rule exists because a page that ignored it was written once and looked
 * wrong: a scene drawn as a small card in the middle of an empty frame, a dog
 * with pointed black ears that read as a cat, a colour field the author called
 * keyframable that could not be keyframed.
 *
 * No Node or Electron imports: it runs in the renderer, in main and in tests.
 */

/** The rules a page cannot break, in short. The lint and the probe enforce them. */
export const MOTION_CONTRACT_LINES: string[] = [
	'A page calls frameflow.define({ duration, settings, moments, seek(t, settings) }) and draws ONLY from t',
	'and settings. No CSS animation or transition, setTimeout, requestAnimationFrame, Date.now, Math.random,',
	'fetch or remote URLs. Inline everything; Inter and Outfit are bundled.',
	'- settings: [{ key, type: "number"|"text"|"color"|"enum", default, label?, min?, max?, animate? }]',
	'- moments: [{ name, duration, flex? }] partition the duration; the flex window (the hold) absorbs whatever',
	'  length the clip has beyond the others, so trimming lengthens the hold and never slows the entrance.',
	'- Helpers: frameflow.progress("in", t) is 0..1 across a moment; frameflow.ease.out/in/inOut/back,',
	'  frameflow.lerp and frameflow.clamp exist, and plain ease(x) and clamp(x, lo, hi) are globals.',
	'- A page that fails its checks is kept as the working text but not drawn; the last version that passed',
	'  stays on screen.',
	'- Write duration and moment lengths in define() as literal numbers (duration: 9.5, not duration: SPEC.duration).',
	'  FrameFlow reads them from the text before the page runs; an expression is only known once the page is run.',
	'- Every page is drawn twice at the same instants, in a different order, and both must match to the pixel.',
	'  A rejection gives the box, how many pixels and how much they differ, and an image of both renders. The two',
	'  usual causes: (a) sub-pixel positions near rest: an eased translate or scale that ends at 0.3 px anti-aliases',
	'  differently each time, so round positions to whole pixels (Math.round) and snap to the rest value once',
	'  within a pixel of it; (b) layout measured before it is updated: reading getBoundingClientRect or offsetWidth',
	'  before setting this t\'s text or size reads the PREVIOUS seek\'s layout. Set everything for t first, then',
	'  measure. Nothing may carry over from one seek(t) call to the next.'
]

/** What makes a page good rather than merely valid. */
export const MOTION_CRAFT_LINES: string[] = [
	'Craft — what separates a good page from a valid one:',
	'1. Fill the frame. The page IS the frame: paint your own background edge to edge (viewBox of the frame size,',
	'   preserveAspectRatio "xMidYMid slice"), unless the layer is meant to sit over footage — then leave it',
	'   transparent. Never draw the scene as a small card floating in empty space unless that was asked for.',
	'   "Keep the top and bottom quiet" (the platform covers them with its own interface) means no IMPORTANT',
	'   content there — still paint the background and scenery through them, edge to edge.',
	'2. Match the look already in the project. Read the existing custom layers (their pages are in the timeline',
	'   read), reuse their palette, line weight and helpers, and when the user gives a palette, use only it.',
	'3. Make every subject read at a glance. Give a character or animal its defining silhouette (a dog: a muzzle,',
	'   floppy or half-folded ears, a tail; a cat: pointed ears, a small nose) and the colours it was asked to have.',
	'   Upright pointed triangle ears read as a cat or a fox, never a dog: a dog\'s ears are rounded and hang,',
	'   flop over or sit half-folded.',
	'   If a viewer could mistake it for something else in a still frame, redraw it.',
	'4. Compose in depth and move like something alive. Separate background, middle and foreground; keep one clear',
	'   focal point; ease everything organic (frameflow.ease.back for overshoot and squash, never linear) and add',
	'   secondary motion — the settle after a stop, the tail that keeps going.',
	'5. Time the beats exactly as the user gave them: their seconds are the contract. Name moments so the entrance',
	'   and exit keep their length when the hold is trimmed.',
	'6. Fields a person may want to change go in `settings`. A number or colour they may want to ANIMATE must be',
	'   declared in the object form with `animate: true`, e.g. `jacket: { type: "color", default: "#7A5BC4", animate: true }`.',
	'   The bare `jacket: "#7A5BC4"` form is NOT keyframable. Never tell the user a field is keyframable unless you',
	'   declared it so.',
	'7. Verify like an editor. render_frame the first frame, every beat, one mid-motion frame and the last frame, and',
	'   fix what you see — cropped content, empty areas, the wrong subject — before you answer. Then report only what',
	'   you verified.'
]

/** The whole guide, as the `get_motion_guide` tool returns it. */
export const motionGuideText = (): string =>
	['MOTION PAGE CONTRACT', ...MOTION_CONTRACT_LINES, '', 'MOTION PAGE CRAFT', ...MOTION_CRAFT_LINES].join('\n')
