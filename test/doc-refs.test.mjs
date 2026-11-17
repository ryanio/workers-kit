import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	bodyHash,
	check,
	editedInPlace,
	extract,
	globToRegExp,
	trackedTree,
} from '../lib/doc-refs.mjs'

const FILES = [
	'AGENTS.md',
	'apps/api/AGENTS.md',
	'apps/api/src/lib/auth.ts',
	'apps/api/scripts/seed.ts',
	'docs/guide.md',
	'.claude/commands/push.md',
	'.agents/skills/sentry/SKILL.md',
	'plans/archived/old.md',
	'docs/sentry-log.md',
]

function run(docs, config, gitIgnored) {
	const files = [...FILES, ...Object.keys(docs).filter((d) => !FILES.includes(d))]
	const { has } = trackedTree(files)
	const read = (f) => docs[f] ?? ''
	return check({ files, read, has, config, gitIgnored }).broken.map(
		(b) => `${b.doc}:${b.line} ${b.token}`
	)
}

test('a moved file is reported, an existing one is not', () => {
	assert.deepEqual(
		run({ 'AGENTS.md': 'See `apps/api/src/lib/auth.ts` and `apps/api/src/auth.ts`.' }),
		['AGENTS.md:1 apps/api/src/auth.ts']
	)
})

test('a path in a sub-folder doc resolves from that folder or the repo root', () => {
	assert.deepEqual(
		run({ 'apps/api/AGENTS.md': '`scripts/seed.ts`, `src/lib/auth.ts`, `scripts/gone.ts`' }),
		['apps/api/AGENTS.md:1 scripts/gone.ts']
	)
})

test('a token whose first segment is not in the repo is not treated as a path', () => {
	assert.deepEqual(run({ 'AGENTS.md': '`users/{uid}/meals`, `data/queue.json`, `owner/repo`' }), [])
})

test('relative links resolve from the doc folder, URLs and anchors are skipped', () => {
	const doc = '[a](../AGENTS.md) [b](../missing.md) [c](https://x.dev) [d](#top) [e](guide.md#part)'
	assert.deepEqual(run({ 'docs/README.md': doc }), ['docs/README.md:1 ../missing.md'])
})

test('fenced blocks and placeholders are skipped', () => {
	const doc =
		'```\n`apps/api/gone.ts`\n```\n`apps/api/.../x.ts` `docs/YYYY-MM-DD.md` `apps/<app>/x.ts`'
	assert.deepEqual(run({ 'AGENTS.md': doc }), [])
})

test('line-number suffixes and module specifiers resolve', () => {
	const doc = '`apps/api/src/lib/auth.ts:12-30` `apps/api/src/lib/auth.js` `apps/api/src/lib/auth`'
	assert.deepEqual(run({ 'AGENTS.md': doc }), [])
})

test('slash names are checked only in command and skill docs', () => {
	const doc = '`/push` `/sentry` `/code-review` `/gone` `/pricing`'
	assert.deepEqual(run({ '.claude/commands/deploy.md': doc }, { externalSlash: ['pricing'] }), [
		'.claude/commands/deploy.md:1 /gone',
	])
	assert.deepEqual(run({ 'AGENTS.md': doc }), [])
})

test('logs and archives are not scanned', () => {
	assert.deepEqual(
		run({ 'plans/archived/old.md': '`apps/gone.ts`', 'docs/sentry-log.md': '`apps/gone.ts`' }),
		[]
	)
})

test('config ignore and gitignored paths pass', () => {
	const doc = '`apps/api/.env.local` `apps/api/dist/out.js` `apps/api/example.ts`'
	const gitIgnored = (paths) => new Set(paths.filter((p) => p.includes('/dist/')))
	assert.deepEqual(run({ 'AGENTS.md': doc }, { ignore: ['apps/api/example.ts'] }, gitIgnored), [])
})

test('a path through a tracked symlink resolves', () => {
	const tree = trackedTree(['.agents/skills/sentry/SKILL.md', '.claude/skills'])
	assert.equal(tree.has('.agents/skills/sentry/SKILL.md'), true)
	assert.equal(tree.has('.agents/skills/'), true)
	assert.equal(tree.has('.agents/skills/nope.md'), false)
})

test('extract numbers lines', () => {
	assert.deepEqual(
		extract('one\n`a/b.ts`\n[x](y.md)').map((r) => [r.kind, r.line]),
		[
			['tick', 2],
			['link', 3],
		]
	)
})

test('globs', () => {
	assert.equal(globToRegExp('**/AGENTS.md').test('AGENTS.md'), true)
	assert.equal(globToRegExp('**/AGENTS.md').test('a/b/AGENTS.md'), true)
	assert.equal(globToRegExp('docs/*.md').test('docs/a/b.md'), false)
})

test('a copy edited in place is caught', () => {
	const body = 'const x = 1\n'
	const banner = `// Generated from ryanio/doc-refs lib/doc-refs.mjs (abc1234, body ${bodyHash(body)}). Edit it there.\n`
	assert.equal(editedInPlace(banner + body), false)
	assert.equal(editedInPlace(`${banner}const x = 2\n`), true)
	assert.equal(editedInPlace(body), false)
})

test('text rules: a required string, a forbidden pattern in a code block, a rule that matches nothing', () => {
	const config = {
		text: [
			{
				docs: ['.agents/skills/sentry/SKILL.md'],
				require: ['dataset=tracemetrics'],
				forbid: ['metrics/(query|meta)/'],
			},
			{ docs: ['docs/gone.md'], require: ['x'] },
		],
	}
	assert.deepEqual(
		run(
			{ '.agents/skills/sentry/SKILL.md': 'Query it.\n```\ncurl sentry.io/api/0/metrics/query/\n```\n' },
			config
		),
		[
			'.agents/skills/sentry/SKILL.md:0 dataset=tracemetrics',
			'.agents/skills/sentry/SKILL.md:3 metrics/query/',
			'doc-refs.config.json:0 docs/gone.md',
		]
	)
	assert.deepEqual(
		run({ '.agents/skills/sentry/SKILL.md': 'Use `dataset=tracemetrics`.' }, { text: [config.text[0]] }),
		[]
	)
})
