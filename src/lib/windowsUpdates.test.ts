import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsArchiveUpdate, type WindowsRelease, type WindowsUpdateManifest } from './windowsUpdates.ts';

const download = 'https://github.com/ssadkov/arni-code/releases/download/v1.0.21/';
const sha256 = 'e'.repeat(64);
const manifest: WindowsUpdateManifest = { version: '1.0.21', commit: 'b'.repeat(40), platform: 'win32-x64-user', assetName: 'ArniCodeSetup.exe', sha256, size: 10 };
const release: WindowsRelease = {
	draft: false, prerelease: false, tag_name: 'v1.0.21', published_at: '2026-11-10T18:09:35Z', body: 'notes',
	assets: [
		{ name: 'ArniCodeSetup.exe', browser_download_url: download + 'ArniCodeSetup.exe', digest: 'sha256:' + sha256, size: 10 },
		{ name: 'ArniCode-win32-x64.zip', browser_download_url: download + 'ArniCode-win32-x64.zip' },
	],
};

test('a zip install is offered the zip of a newer release', () => {
	assert.deepEqual([
		windowsArchiveUpdate(release, manifest, 'a'.repeat(40), '1.0.19'),
		windowsArchiveUpdate(release, manifest, 'a'.repeat(40), '1.0.21'),
		windowsArchiveUpdate({ ...release, assets: release.assets.slice(0, 1) }, manifest, 'a'.repeat(40), '1.0.19'),
	], [
		{ url: download + 'ArniCode-win32-x64.zip', version: 'b'.repeat(40), productVersion: '1.0.21', timestamp: Date.parse('2026-11-10T18:09:35Z'), releaseNotes: 'notes' },
		null,
		null,
	]);
});
