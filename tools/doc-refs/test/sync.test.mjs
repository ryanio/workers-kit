import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(dirname(fileURLToPath(import.meta.url)))
const consumers = JSON.parse(readFileSync(join(HERE, 'consumers.json'), 'utf8'))
const sync = (dev, ...args) =>
	spawnSync('node', [join(HERE, 'sync.mjs'), ...args], {
		env: { ...process.env, DOC_REFS_DEV: dev },
		encoding: 'utf8',
	})

test('sync refuses to overwrite a copy edited in place until --force', () => {
	const dev = mkdtempSync(join(tmpdir(), 'doc-refs-sync-'))
	assert.equal(sync(dev).status, 0)
	const [edited, other] = consumers.map((c) => join(dev, c.repo, c.dir, 'doc-refs.mjs'))
	const hand = `${readFileSync(edited, 'utf8')}// a local fix\n`
	writeFileSync(edited, hand)
	writeFileSync(other, 'stale\n')

	const refused = sync(dev)
	assert.equal(refused.status, 1)
	assert.match(refused.stderr, /edited in place/)
	assert.equal(readFileSync(edited, 'utf8'), hand)
	assert.notEqual(readFileSync(other, 'utf8'), 'stale\n', 'the other copies still sync')

	assert.equal(sync(dev, '--force').status, 0)
	assert.equal(sync(dev, '--check').status, 0)
})
