import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowsUpdate, windowsReleaseAsset } from '../src/lib/windowsUpdates.ts';
const sha256 = 'a'.repeat(64); const commit = 'b'.repeat(40); const previous = 'c'.repeat(40);
function fixture() {
	const manifest = { version: '1.0.19', commit, platform: 'win32-x64-user', assetName: 'ArniCodeSetup.exe', sha256, size: 123 };
	const release = { draft: false, prerelease: false, tag_name: 'v1.0.19', published_at: '2026-11-09T12:00:00Z', assets: [
		{ name: manifest.assetName, browser_download_url: 'https://github.com/ssadkov/arni-code/releases/download/v1.0.19/' + manifest.assetName, digest: 'sha256:' + sha256, size: 123 },
		{ name: 'update-win32-x64.json', browser_download_url: 'https://github.com/ssadkov/arni-code/releases/download/v1.0.19/update-win32-x64.json' },
	] };
	return { release, manifest };
}
test('offers a digest-verified installer to an older Windows version', () => {
	const { release, manifest } = fixture(); const update = windowsUpdate(release, manifest, previous, '1.0.18');
	assert.deepEqual(update, { url: release.assets[0].browser_download_url, version: commit, productVersion: '1.0.19', sha256hash: sha256, size: 123, timestamp: Date.parse(release.published_at), releaseNotes: '' });
});
test('declines current, newer, pending-identical and malformed client versions', () => {
	const { release, manifest } = fixture();
	for (const version of ['1.0.19', '1.0.20', '2.0.0', '1.0.18-beta', 'invalid']) { assert.equal(windowsUpdate(release, manifest, previous, version), null); }
	assert.equal(windowsUpdate(release, manifest, commit, '1.0.18'), null);
});
test('rejects wrong channel, repository, platform, tag, hash, size and missing digest', () => {
	for (const mutate of [
		f => { f.release.draft = true; }, f => { f.release.prerelease = true; },
		f => { f.release.tag_name = 'v1.0.20'; }, f => { f.manifest.platform = 'win32-x64'; },
		f => { f.release.assets[0].browser_download_url = 'https://example.com/ArniCodeSetup.exe'; },
		f => { f.release.assets[0].browser_download_url += '?redirect=unsafe'; },
		f => { f.release.assets[0].digest = undefined; }, f => { f.release.assets[0].digest = 'sha256:' + 'd'.repeat(64); },
		f => { f.release.assets[0].size++; }, f => { f.manifest.commit = 'invalid'; },
	]) { const f = fixture(); mutate(f); assert.equal(windowsUpdate(f.release, f.manifest, previous, '1.0.18'), null); }
});
test('only fetches the update manifest from its exact stable release asset URL', () => {
	const { release } = fixture(); assert.ok(windowsReleaseAsset(release, 'update-win32-x64.json'));
	release.assets[1].browser_download_url = 'https://github.com/another/repo/releases/download/v1.0.19/update-win32-x64.json';
	assert.equal(windowsReleaseAsset(release, 'update-win32-x64.json'), undefined);
});
