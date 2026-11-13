/**
 * One colour space for the whole export: SDR, BT.709, limited range.
 *
 * The export used to convert nothing. Each region file inherited the colour
 * tags of whatever footage it was cut from, and the join (`-c copy`) keeps ONLY
 * the first region's header, so a project that opens on an iPhone clip (HLG,
 * BT.2020) came out as one file labelled HLG although most of it was BT.709
 * DJI footage. A player that obeys the label then decodes every BT.709 pixel
 * with the wrong matrix and curve. Two more places drifted the same way:
 *
 *  - an HLG clip was never tone-mapped, so it stayed flat and orange;
 *  - a motion layer (titles, cards) is RGB, and the RGB to YUV step in the
 *    graph defaults to the BT.601 matrix, so a saturated colour moved by about
 *    10 levels once the result was read as BT.709.
 *
 * So: every source is brought to BT.709 SDR on its way in, and every region is
 * then TAGGED as BT.709, so that the label is true for every pixel. This file
 * only builds filter strings; it spawns nothing.
 */

export interface SourceColor {
	/** ffprobe's `color_transfer`, e.g. `arib-std-b67` (HLG) or `smpte2084` (PQ). */
	transfer?: string
	/** ffprobe's `color_primaries`, e.g. `bt2020`. */
	primaries?: string
	/** ffprobe's `color_space` (the matrix), e.g. `bt2020nc`. Absent on files probed before it was recorded. */
	matrix?: string
}

/** What a source needs on its way in. */
export type ColorAction = 'none' | 'tonemap' | 'convert'

const known = (v?: string): string | undefined => (v && v !== 'unknown' && v !== 'unspecified' ? v : undefined)

const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084'])

/** ffprobe's names for a matrix, as zscale spells them. */
const ZSCALE_MATRIX: Record<string, string> = {
	bt709: '709', smpte170m: '170m', bt470bg: '470bg', bt2020nc: '2020_ncl', bt2020c: '2020_cl'
}
/** ffprobe's names for primaries, as zscale spells them. zscale has no 470bg: PAL's are within a hair of 170m's. */
const ZSCALE_PRIMARIES: Record<string, string> = {
	bt709: '709', smpte170m: '170m', bt470bg: '170m', smpte240m: '170m', bt2020: '2020'
}

/**
 * The matrix a source is coded in: its tag, else what its primaries imply, else
 * BT.709. A file that says nothing is left as it is: guessing (players take SD
 * for BT.601) would change pictures nobody asked to change.
 */
function matrixOf(color: SourceColor): string {
	const matrix = known(color.matrix)
	if (matrix) return matrix
	const primaries = known(color.primaries)
	if (primaries === 'bt2020') return 'bt2020nc'
	if (primaries === 'smpte170m' || primaries === 'bt470bg') return primaries
	return 'bt709'
}

function primariesOf(color: SourceColor): string {
	const primaries = known(color.primaries)
	if (primaries && ZSCALE_PRIMARIES[primaries]) return primaries
	const matrix = matrixOf(color)
	return matrix === 'bt2020nc' || matrix === 'bt2020c' ? 'bt2020' : matrix === 'bt709' ? 'bt709' : 'smpte170m'
}

export function colorAction(color: SourceColor | undefined): ColorAction {
	if (!color) return 'none'
	const transfer = known(color.transfer)
	if (transfer && HDR_TRANSFERS.has(transfer)) return 'tonemap'
	return matrixOf(color) !== 'bt709' || primariesOf(color) !== 'bt709' ? 'convert' : 'none'
}

/**
 * The filters that bring a source to BT.709 SDR, or '' when it already is.
 *
 * The INPUT side is written out (`tin`, `pin`, `min`) instead of left to the
 * frame's own tags: a proxy is re-tagged for the browser (see
 * ffmpeg/proxyTags.ts) and no longer says what its pixels are.
 */
export function sourceColorFilter(color: SourceColor | undefined): string {
	const action = colorAction(color)
	if (action === 'none' || !color) return ''
	const min = ZSCALE_MATRIX[matrixOf(color)] ?? '709'
	const pin = ZSCALE_PRIMARIES[primariesOf(color)] ?? '709'
	if (action === 'convert') {
		// BT.601, BT.709 and SDR BT.2020 share one transfer curve, so only the matrix and primaries
		// move. The curve is still NAMED: moving primaries goes through linear light, and zscale
		// refuses ("no path between colorspaces") when the file does not say what its curve is.
		return `zscale=min=${min}:pin=${pin}:tin=709:rin=limited:m=709:p=709:t=709:r=limited`
	}
	// HDR: to linear light, onto BT.709's primaries, tone-mapped to SDR, back to BT.709's curve.
	const tin = known(color.transfer)!
	return [
		`zscale=tin=${tin}:pin=${pin}:min=${min}:rin=limited:t=linear:npl=100`,
		'format=gbrpf32le',
		'zscale=p=709',
		'tonemap=tonemap=hable:desat=0',
		'zscale=t=709:m=709:r=limited',
		'format=yuv420p'
	].join(',')
}

/**
 * A motion layer or a generated colour is RGB (or YUV coded as BT.601) and has
 * to meet the picture in BT.709. The matrix is named in the same step that makes
 * it YUV: left to the graph's automatic converter it is BT.601.
 */
export const RGB_TO_BT709 = 'scale=out_color_matrix=bt709:out_range=tv'

/** A generated colour: a lavfi `color` source is YUV coded as BT.601. Out to RGB (read as BT.601) and back in as BT.709. */
export const GENERATED_TO_BT709 = `format=gbrp,${RGB_TO_BT709},format=yuv420p`

/**
 * Stamps the frames BT.709 / SDR / limited, so the encoder writes that and the
 * join (which keeps the first region's header for the whole file) is right for
 * every region. The `-colorspace` family of output options cannot do this: they
 * set the matrix but leave the frame's own transfer and primaries standing.
 */
export const SDR_TAG_FILTER = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'
