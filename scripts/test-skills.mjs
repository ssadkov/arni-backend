// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const base = process.argv[2] || 'http://127.0.0.1:31973';
const request = options => fetch(base + '/api/skills/library', { ...options, signal: AbortSignal.timeout(20_000) });
const response = await request();
assert.equal(response.status, 200);
assert.equal(response.headers.get('access-control-allow-origin'), '*');
const catalog = await response.json();
assert.equal(catalog.schemaVersion, 1);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
for (const file of catalog.files) { assert.equal(hash(file.text), file.sha256); }
const files = [...catalog.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
assert.equal(hash(JSON.stringify(files.map(file => [file.path, file.sha256]))), catalog.revision);
assert.ok(files.some(file => file.path === 'agents/content-editor.agent.md'));
assert.ok(files.some(file => file.path === 'skills/media-toolkit/scripts/media.py'));
assert.equal(files.some(file => /capcut/i.test(file.path)), false);
const etag = response.headers.get('etag');
assert.equal(etag.replace(/^W\//, ''), '"' + catalog.revision + '"');
const unchanged = await request({ headers: { 'If-None-Match': etag } });
assert.equal(unchanged.status, 304);
assert.equal(await unchanged.text(), '');
const options = await request({ method: 'OPTIONS' });
assert.equal(options.status, 204);
assert.equal(options.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
console.log(JSON.stringify({ endpoint: base + '/api/skills/library', revision: catalog.revision, files: files.length, checks: ['anonymous GET', 'integrity', 'ETag 304', 'CORS', 'no CapCut'] }));
