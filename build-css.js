/* eslint-disable no-console */
import {
	readFileSync,
	writeFileSync,
	readdirSync,
	existsSync,
	mkdirSync,
	statSync,
	unlinkSync,
} from 'fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';
import { bundleAsync, browserslistToTargets } from 'lightningcss';
import browserslist from 'browserslist';
import { paths } from './gulp/constants.js';
import { replaceInlineCSS } from './gulp/utils.js';
import themeConfig from './config/themeConfig.js'; // merged config (default + user)

/** Theme slug used for URL replacements (fallback to config or default). */
const themeSlug = themeConfig?.theme?.slug || themeConfig?.slug || 'wprig';
/** Development mode flag (enables sourcemaps, disables minify). */
const isDev = process.argv.includes( '--dev' );

/**
 * Ensure a directory exists, creating it recursively if necessary.
 *
 * @param {string} dir - Absolute or relative directory path.
 * @return {void}
 */
function ensureDirectoryExistence( dir ) {
	if ( ! existsSync( dir ) ) {
		mkdirSync( dir, { recursive: true } );
	}
}

// Make sure output roots exist ahead of time.
ensureDirectoryExistence( paths.styles.dest );
ensureDirectoryExistence( paths.styles.editorDest );

/**
 * Resolve the list of CSS files that must be prepended (loaded before every entry).
 * Preferred key: dev.styles.preload
 * Legacy alias (deprecated): dev.styles.importFrom
 *
 * - Accepts relative paths (resolved against paths.styles.srcDir) and absolute paths.
 * - Ignores missing files.
 * - De-duplicates while preserving the original order of the first occurrence.
 *
 * @return {string[]} Absolute file paths in the order they should be imported.
 */
function resolveImportFromList() {
	const stylesCfg = themeConfig?.dev?.styles ?? {};

	// Preferred new key
	const prefer = Array.isArray( stylesCfg.preload )
		? stylesCfg.preload
		: null;

	// Legacy alias (deprecated) – used only if "preload" is not provided
	const legacy = Array.isArray( stylesCfg.importFrom )
		? stylesCfg.importFrom
		: null;

	// Choose list: prefer "preload"; fallback to legacy
	const list = prefer && prefer.length ? prefer : legacy || [];

	// Warn once if we fell back to the legacy key
	if ( ( ! prefer || ! prefer.length ) && legacy && legacy.length ) {
		if ( ! resolveImportFromList._warnedLegacy ) {
			console.warn(
				'[build-css] DEPRECATION: "dev.styles.importFrom" is deprecated. ' +
					'Please migrate to "dev.styles.preload". Legacy key is still supported for now.'
			);
			resolveImportFromList._warnedLegacy = true;
		}
	}

	// Normalize to absolute paths, keep first occurrence of each
	const seen = new Set();
	const resolved = [];

	for ( const p of list ) {
		const abs = path.isAbsolute( p )
			? p
			: path.resolve( paths.styles.srcDir, p );
		if ( ! existsSync( abs ) ) {
			continue;
		}
		if ( seen.has( abs ) ) {
			continue;
		}
		seen.add( abs );
		resolved.push( abs );
	}

	return resolved;
}

/**
 * Replace theme URL shorthands with absolute theme paths.
 *
 * Supported shorthands (kept for backwards compatibility):
 * - url('~theme/…')         -> /wp-content/themes/<slug>/…
 * - url('theme-assets/…')   -> /wp-content/themes/<slug>/assets/…
 *
 * @param {string} css - Raw CSS string.
 * @return {string} The processed CSS string with theme paths replaced.
 */
function processThemeUrls( css ) {
	const themeName = themeSlug;

	// ~theme/…
	let processedCSS = css.replace(
		/url\((['"]?)~theme\/([^'")]+)(['"]?)\)/g,
		( _match, _q1, relPath /*,_q3*/ ) => {
			return `url('/wp-content/themes/${ themeName }/${ relPath }')`;
		}
	);

	// theme-assets/…
	processedCSS = processedCSS.replace(
		/url\((?:['"]?)theme-assets\/([^'")]+)(?:['"]?)\)/g,
		( _match, assetPath ) => {
			return `url('/wp-content/themes/${ themeName }/assets/${ assetPath }')`;
		}
	);

	return processedCSS;
}

/**
 * Recursively collect all `.css` files (excluding partials starting with `_`),
 * and skipping internal folders like `.virtual`.
 *
 * @param {string} dir - Directory to scan.
 * @return {string[]} List of absolute file paths for CSS entries.
 */
function getAllFiles( dir ) {
	const entries = readdirSync( dir, { withFileTypes: true } );
	let filelist = [];
	for ( const entry of entries ) {
		const full = path.join( dir, entry.name );
		if ( entry.isDirectory() ) {
			// Skip internal temp folder just in case
			if ( entry.name === '.virtual' ) {
				continue;
			}
			filelist = filelist.concat( getAllFiles( full ) );
		} else if ( entry.isFile() ) {
			const parsed = path.parse( full );
			if (
				parsed.ext.toLowerCase() === '.css' &&
				! parsed.base.startsWith( '_' )
			) {
				filelist.push( full );
			}
		}
	}
	return filelist;
}

/**
 * Create a real on-disk "virtual entry" CSS file that imports:
 *  - all `importFrom` files first, then
 *  - the actual entry file.
 *
 * We place it in the OS temp directory to avoid triggering your file watchers.
 *
 * @param {string[]} prependFiles - Absolute paths to files that must come first.
 * @param {string}   entryFile    - Absolute path to the real entry file.
 * @return {string} Absolute path to the temporary virtual entry file.
 */
function createVirtualEntry( prependFiles, entryFile ) {
	// Use an external temp dir (outside the watched source tree)
	const baseTmpDir = path.join( os.tmpdir(), 'wprig-lcss' );
	ensureDirectoryExistence( baseTmpDir );

	// Use a random file name to avoid collisions under watch
	const fileName = `entry-${ randomBytes( 6 ).toString( 'hex' ) }.css`;
	const virtualPath = path.join( baseTmpDir, fileName );

	// Build imports using POSIX-style separators for CSS
	const toPosixRel = ( fromDir, abs ) =>
		path.relative( fromDir, abs ).split( path.sep ).join( '/' );

	const mkImport = ( fromDir, abs ) =>
		`@import "${ toPosixRel( fromDir, abs ) }";`;

	const contents =
		prependFiles
			.map( ( abs ) => mkImport( baseTmpDir, abs ) )
			.join( '\n' ) +
		'\n' +
		mkImport( baseTmpDir, entryFile ) +
		'\n';

	writeFileSync( virtualPath, contents, 'utf8' );
	return virtualPath;
}

/**
 * Remove a temporary virtual entry file. Ignores errors.
 *
 * @param {string} file - Absolute path to the temporary file.
 * @return {void}
 */
function cleanupVirtualEntry( file ) {
	try {
		if ( file && existsSync( file ) ) {
			unlinkSync( file );
		}
	} catch {
		// ignore
	}
}

/**
 * Build a single CSS entry with LightningCSS `bundleAsync` and correct sourcemaps.
 * Uses a real temporary entry file to guarantee import order and robust resolving.
 *
 * @param {string} filePath   - Absolute path to the input CSS entry file.
 * @param {string} outputPath - Absolute path to the compiled CSS output file.
 * @return {Promise<void>} Resolves when processing is complete.
 */
/**
 * Build a single CSS entry with LightningCSS `bundleAsync` and correct sourcemaps.
 * Uses a real temporary entry file to guarantee import order and robust resolving.
 *
 * @param {string} filePath   - Absolute path to the input CSS entry file.
 * @param {string} outputPath - Absolute path to the compiled CSS output file.
 * @return {Promise<void>} Resolves when processing is complete.
 */
async function processCSSFile( filePath, outputPath ) {
	// Build virtual prelude from config (e.g., tokens/_custom-media.css)
	const prependFiles = resolveImportFromList();
	const virtualEntry = createVirtualEntry( prependFiles, filePath );

	// Derive LightningCSS targets from Browserslist (auto-loads config from repo)
	let targets;
	try {
		const bl = browserslist(); // reads from package.json/.browserslistrc
		targets = browserslistToTargets( bl );
	} catch {
		targets = browserslistToTargets( [ 'defaults' ] );
	}

	try {
		const { code, map } = await bundleAsync( {
			filename: virtualEntry,
			minify: ! isDev,
			sourceMap: isDev,
			drafts: { customMedia: true },
			projectRoot: paths.styles.srcDir,
			targets,
			resolver: {
				// Transform sources BEFORE mapping is generated, so sourcemaps stay correct
				read( resolvedPath ) {
					const raw = readFileSync( resolvedPath, 'utf8' );
					return replaceInlineCSS( processThemeUrls( raw ) );
				},
			},
		} );

		// Write exactly what LightningCSS emitted; no post-string transforms here
		writeFileSync( outputPath, code.toString() );

		if ( map ) {
			const mapPath = `${ outputPath }.map`;
			writeFileSync( mapPath, map );
			// Append sourceMappingURL so DevTools can automatically load the sourcemap
			writeFileSync(
				outputPath,
				readFileSync( outputPath, 'utf8' ) +
					`\n/*# sourceMappingURL=${ path.basename( mapPath ) } */`
			);
		}
	} finally {
		// Always remove the virtual entry to keep the fs clean
		cleanupVirtualEntry( virtualEntry );
	}
}

/**
 * Process all CSS files within a directory and write outputs to target dir.
 * Output files are named `<name>.min.css` alongside a `.map` file in the same folder.
 *
 * @param {string} dir     - Source directory to scan.
 * @param {string} destDir - Target directory for compiled CSS.
 * @return {Promise<void>} Resolves when processing is complete.
 */
async function processDirectory( dir, destDir ) {
	const files = getAllFiles( dir );
	for ( const file of files ) {
		const relativePath = path.relative( dir, file );
		const parsed = path.parse( relativePath ); // { dir, name, ext: '.css' }
		const outDir = path.join( destDir, parsed.dir );
		const outFile = path.join(
			outDir,
			`${ parsed.name }.min${ parsed.ext }`
		); // -> .min.css

		ensureDirectoryExistence( outDir );
		await processCSSFile( file, outFile );
	}
}

// Build main + editor CSS trees
( async () => {
	const list = resolveImportFromList();
	console.log( '[build-css] importFrom files:', list );
	await processDirectory( paths.styles.srcDir, paths.styles.dest );
	await processDirectory(
		paths.styles.editorSrcDir,
		paths.styles.editorDest
	);
} )();
