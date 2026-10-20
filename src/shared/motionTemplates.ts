import type { MotionDefinition, MotionSettingDef } from './motion'
import lowerThird from './motion-templates/lower-third.html?raw'
import titleCard from './motion-templates/title-card.html?raw'
import chapterCard from './motion-templates/chapter-card.html?raw'
import pullQuote from './motion-templates/pull-quote.html?raw'
import statCounter from './motion-templates/stat-counter.html?raw'
import calloutRing from './motion-templates/callout-ring.html?raw'
import barReveal from './motion-templates/bar-reveal.html?raw'

/**
 * The bundled motion library — board 1's Motion tab.
 *
 * Each template is a page (`motion-templates/*.html`) plus its definition. The
 * definition lives HERE rather than inside the page so the editor can read a
 * template's settings and moments without running it; the runtime hands the
 * same object to the page as `frameflow.definition`, and the page's own
 * `define()` only supplies `seek`. A test checks every page still lints clean
 * and still calls `define`.
 *
 * No `normaliseDefinition` import here on purpose: motion.ts imports this file,
 * and every definition below already partitions its duration exactly (a test
 * asserts that too).
 */

export interface MotionTemplate {
	id: string
	label: string
	section: 'Text' | 'Data and callouts'
	/** What the library tile and the AI context say it is for. */
	description: string
	definition: MotionDefinition
	html: string
}

const accent: MotionSettingDef = { key: 'accent', label: 'Accent', type: 'color', default: '#EC4899' }

/** in / hold / out, the hold flexible. Most templates are shaped like this. */
const inHoldOut = (inSec: number, holdSec: number, outSec: number) => [
	{ name: 'in', duration: inSec },
	{ name: 'hold', duration: holdSec, flex: true },
	{ name: 'out', duration: outSec }
]

export const MOTION_TEMPLATES: MotionTemplate[] = [
	{
		id: 'lower-third',
		label: 'Lower third',
		section: 'Text',
		description: 'A name and a role, low on the left — introduce whoever is speaking.',
		html: lowerThird,
		definition: {
			duration: 4,
			moments: inHoldOut(0.4, 3.2, 0.4),
			settings: [
				{ key: 'name', label: 'Name', type: 'text', default: 'Sara Ahmadi' },
				{ key: 'role', label: 'Role', type: 'text', default: 'Founder, BytePets' },
				accent,
				{
					key: 'style', label: 'Style', type: 'enum', default: 'bar',
					options: [{ value: 'bar', label: 'Bar' }, { value: 'pill', label: 'Pill' }, { value: 'glass', label: 'Glass' }]
				},
				{ key: 'slide', label: 'Slide', type: 'number', default: 24, min: 0, max: 60, step: 1, unit: 'px', animate: true }
			]
		}
	},
	{
		id: 'title-card',
		label: 'Title card',
		section: 'Text',
		description: 'One big centred line with an optional subtitle — an opener or a section title.',
		html: titleCard,
		definition: {
			duration: 3,
			moments: inHoldOut(0.6, 1.9, 0.5),
			settings: [
				{ key: 'title', label: 'Title', type: 'text', default: 'TITLE' },
				{ key: 'subtitle', label: 'Subtitle', type: 'text', default: '' },
				{ key: 'colour', label: 'Colour', type: 'color', default: '#FAFAFA' },
				accent,
				{ key: 'scale', label: 'Scale', type: 'number', default: 1, min: 0.5, max: 2, step: 0.01, unit: '×', animate: true }
			]
		}
	},
	{
		id: 'chapter-card',
		label: 'Chapter card',
		section: 'Text',
		description: 'A kicker and a title beside an accent bar — marks a new chapter.',
		html: chapterCard,
		definition: {
			duration: 2,
			moments: inHoldOut(0.4, 1.2, 0.4),
			settings: [
				{ key: 'title', label: 'Title', type: 'text', default: 'Chapter' },
				{ key: 'kicker', label: 'Kicker', type: 'text', default: 'Part 1' },
				accent
			]
		}
	},
	{
		id: 'pull-quote',
		label: 'Pull quote',
		section: 'Text',
		description: 'A quotation that fades up word by word, then its attribution.',
		html: pullQuote,
		definition: {
			duration: 5,
			moments: inHoldOut(1.2, 3.3, 0.5),
			settings: [
				{ key: 'quote', label: 'Quote', type: 'text', default: 'It finally feels like the tool is listening.', multiline: true },
				{ key: 'attribution', label: 'Attribution', type: 'text', default: '— Early user' },
				accent
			]
		}
	},
	{
		id: 'stat-counter',
		label: 'Stat counter',
		section: 'Data and callouts',
		description: 'A number that counts up to its value beside what it means.',
		html: statCounter,
		definition: {
			duration: 4,
			moments: inHoldOut(1, 2.6, 0.4),
			settings: [
				{ key: 'label', label: 'Label', type: 'text', default: 'faster triage' },
				{ key: 'value', label: 'Value', type: 'number', default: 3, min: -1e6, max: 1e6, step: 0.1, animate: true },
				{ key: 'prefix', label: 'Prefix', type: 'text', default: '' },
				{ key: 'suffix', label: 'Suffix', type: 'text', default: '×' },
				{ key: 'decimals', label: 'Decimals', type: 'number', default: 0, min: 0, max: 2, step: 1 },
				accent
			]
		}
	},
	{
		id: 'callout-ring',
		label: 'Callout ring',
		section: 'Data and callouts',
		description: 'A ring that draws itself around a point in the frame, with a pointer and a note.',
		html: calloutRing,
		definition: {
			duration: 2.5,
			moments: inHoldOut(0.6, 1.5, 0.4),
			settings: [
				{ key: 'label', label: 'Note', type: 'text', default: 'Look here' },
				{ key: 'x', label: 'Across', type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, unit: '%', animate: true },
				{ key: 'y', label: 'Down', type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, unit: '%', animate: true },
				{ key: 'size', label: 'Size', type: 'number', default: 0.12, min: 0.02, max: 0.5, step: 0.01, unit: '%', animate: true },
				accent
			]
		}
	},
	{
		id: 'bar-reveal',
		label: 'Bar reveal',
		section: 'Data and callouts',
		description: 'A short bar chart that grows bar by bar; the biggest bar takes the accent.',
		html: barReveal,
		definition: {
			duration: 3.5,
			moments: inHoldOut(1.2, 1.9, 0.4),
			settings: [
				{ key: 'title', label: 'Title', type: 'text', default: '' },
				{ key: 'values', label: 'Values', type: 'text', default: '40, 70, 100' },
				{ key: 'labels', label: 'Labels', type: 'text', default: 'Q1, Q2, Q3' },
				{ key: 'unit', label: 'Unit', type: 'text', default: '' },
				accent
			]
		}
	}
]

const byId = new Map(MOTION_TEMPLATES.map((t) => [t.id, t]))

export const motionTemplate = (id: string | undefined): MotionTemplate | undefined =>
	id ? byId.get(id) : undefined

/** Templates grouped for the library panel, in catalogue order. */
export function motionSections(): { section: MotionTemplate['section']; templates: MotionTemplate[] }[] {
	const out: { section: MotionTemplate['section']; templates: MotionTemplate[] }[] = []
	for (const t of MOTION_TEMPLATES) {
		const group = out.find((g) => g.section === t.section)
		if (group) group.templates.push(t)
		else out.push({ section: t.section, templates: [t] })
	}
	return out
}
