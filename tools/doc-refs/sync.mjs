#!/usr/bin/env node
/**
 * Copies lib/doc-refs.mjs into every consumer repo listed in consumers.json.
 *
 *   node sync.mjs           write the copies (repos are siblings of workers-kit)
 *   node sync.mjs --check   exit 1 if any copy differs from lib/, write nothing
 *   node sync.mjs --report  run each repo's copy in report mode
 *
 * Consumers vendor the file rather than depending on workers-kit, so CI, a
 * worktree or a cloud session needs no access to it. Each copy gets a banner
 * with a hash of its body; the copy refuses to run, and sync refuses to
 * overwrite it, if it was edited in place.
 * A consumer's doc-refs.config.json sits beside its copy and is never synced.
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BANNER_RE, bodyHash, editedInPlace } from './lib/doc-refs.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV = dirname(dirname(dirname(HERE)))
const FILE = 'doc-refs.mjs'
let mode = 'write'
if (process.argv.includes('--check')) {
	mode = 'check'
} else if (process.argv.includes('--report')) {
	mode = 'report'
}
const consumers = JSON.parse(readFileSync(join(HERE, 'consumers.json'), 'utf8'))

function sha() {
	try {
		const out = execSync(`git log -1 --format=%h -- lib/${FILE}`, {
			cwd: HERE,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim()
		return out || 'uncommitted'
	} catch {
		return 'uncommitted'
	}
}

const strip = (text) => text.replace(BANNER_RE, '')

function withBanner(source) {
	const banner = `// Generated from ryanio/workers-kit tools/doc-refs/lib/${FILE} (${sha()}, body ${bodyHash(source)}). Edit it there and run \`npm run sync\`; changes made here are refused.\n`
	const nl = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0
	return source.slice(0, nl) + banner + source.slice(nl)
}

const source = readFileSync(join(HERE, 'lib', FILE), 'utf8')
let bad = 0
for (const { repo, dir } of consumers) {
	const target = join(DEV, repo, dir)
	const path = join(target, FILE)
	if (mode === 'report') {
		console.log(`── ${repo}`)
		try {
			execFileSync('node', [path, '--report'], { cwd: join(DEV, repo), stdio: 'inherit' })
		} catch {
			bad++
		}
		continue
	}
	const current = existsSync(path) ? readFileSync(path, 'utf8') : null
	if (mode === 'check') {
		if (current === null || strip(current) !== source) {
			console.error(`${repo}: ${dir}/${FILE} differs from lib/${FILE}`)
			bad++
		}
		continue
	}
	if (current !== null && editedInPlace(current)) {
		console.error(`${repo}: ${dir}/${FILE} was edited in place; move the change into lib/ or restore it, then sync again`)
		bad++
		continue
	}
	const next = withBanner(source)
	if (current !== next) {
		mkdirSync(target, { recursive: true })
		writeFileSync(path, next)
		console.log(`${repo}: wrote ${dir}/${FILE}`)
	}
}

if (mode === 'check') {
	console.log(bad ? `${bad} cop(ies) out of sync` : 'all consumers in sync')
}
process.exit(bad ? 1 : 0)
