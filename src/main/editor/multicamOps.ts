import { v4 as uuidv4 } from 'uuid'
import type { EditorDocument, EditorOps, TimelineDiff } from '@shared/types'
import { applyMulticamOps as applyShared } from '@shared/multicamEdits'

export { opsTouchMulticam } from '@shared/multicamEdits'

/**
 * The camera-group ops' JSON schema, for apply_ops. The mapping itself lives
 * in shared/multicamEdits.ts, shared with the editor's own controls.
 */

const ANGLE = { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }] }
const GROUP = { type: 'string', description: 'Camera group id or name; may be left out when the project has one group' }

const SPEAKER = { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }], description: 'A speaker: its number (1, 2…), id or name (get_multicam lists them)' }

export const MULTICAM_OPS_SCHEMA = {
	placeMulticam: {
		type: 'object',
		description: 'Lay a camera group on the timeline: its main sound on an audio track, and one shot of `angle` (default the first) over it on a video track. Then cut between angles with switchAngles. A group comes from make_multicam.',
		properties: {
			group: GROUP,
			atSec: { type: 'number', minimum: 0, description: 'TIMELINE seconds; the end of the timeline by default' },
			fromSec: { type: 'number', description: 'GROUP seconds (get_multicam) to start from; the start of the main sound by default' },
			toSec: { type: 'number', description: 'GROUP seconds to end at; the end of the main sound by default' },
			angle: ANGLE
		},
		additionalProperties: false
	},
	switchAngles: {
		type: 'object',
		description: 'Cut between a placed group’s angles: from each atSec (TIMELINE seconds) the shot shows that angle, until the next switch, untilSec, or the end. Shots are split where a switch lands; the sound is untouched, so nothing goes out of sync. An angle is its number (1, 2…), its name ("Cam 2") or its media id. Use get_angles to see every angle of a stretch side by side first.',
		properties: {
			group: GROUP,
			switches: {
				type: 'array', minItems: 1,
				items: { type: 'object', properties: { atSec: { type: 'number', minimum: 0 }, angle: ANGLE }, required: ['atSec', 'angle'], additionalProperties: false }
			},
			untilSec: { type: 'number', minimum: 0, description: 'Where the last switch ends (TIMELINE seconds); the end of the shots by default' }
		},
		required: ['switches'],
		additionalProperties: false
	},
	setMainSound: {
		type: 'object',
		description: 'Which member’s sound plays under every shot of a group: a camera, or a separate recorder. get_multicam lists each member’s measured sound quality.',
		properties: { group: GROUP, sound: ANGLE },
		required: ['sound'],
		additionalProperties: false
	},
	setSpeaker: {
		type: 'object',
		description: 'Name or describe a voice that find_speakers found (it only knows "Speaker 1, 2…"): `name`, the `camera` (angle number or name) the person is on, and `framing` (where in that camera’s picture: "left of the two-shot"). Look at the sample frames get_speakers shows before naming. The names then appear on get_multicam’s transcript lines and in get_angles.',
		properties: {
			group: GROUP, speaker: SPEAKER,
			name: { type: 'string', minLength: 1 },
			camera: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }, { type: 'null' }], description: 'null clears it' },
			framing: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'null clears it' },
			color: { type: 'string', description: 'A CSS colour, for the transcript and turn bar' }
		},
		required: ['speaker'],
		additionalProperties: false
	},
	mergeSpeakers: {
		type: 'object',
		description: 'Two voices that are one person (the analysis split one voice in two, e.g. loud and quiet): every turn of `from` becomes `into`’s and `from` goes away.',
		properties: { group: GROUP, from: SPEAKER, into: SPEAKER },
		required: ['from', 'into'],
		additionalProperties: false
	},
	setSpeakerTurns: {
		type: 'object',
		description: 'Fix who speaks: give each stretch (GROUP seconds, as get_multicam shows them) to a speaker, or null for "unsure". Fixes survive a new analysis. Use it where the analysis was unsure or wrong; check against get_angles frames.',
		properties: {
			group: GROUP,
			turns: {
				type: 'array', minItems: 1,
				items: {
					type: 'object',
					properties: { fromSec: { type: 'number' }, toSec: { type: 'number' }, speaker: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }, { type: 'null' }] } },
					required: ['fromSec', 'toSec', 'speaker'], additionalProperties: false
				}
			}
		},
		required: ['turns'],
		additionalProperties: false
	},
	nudgeAngle: {
		type: 'object',
		description: 'Move one member of a group on its clock by bySec (positive: later) when the sync is a little off. Every shot of it follows.',
		properties: { group: GROUP, angle: ANGLE, bySec: { type: 'number', minimum: -10, maximum: 10 } },
		required: ['angle', 'bySec'],
		additionalProperties: false
	}
}

export function applyMulticamOps(
	ops: EditorOps, doc: EditorDocument, diff: TimelineDiff, droppedOps: string[], notes: string[],
	newId: () => string = uuidv4
): void {
	applyShared(ops, doc, diff, droppedOps, notes, newId)
}
