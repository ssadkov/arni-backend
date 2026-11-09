export type WindowsReleaseAsset = { name: string; browser_download_url: string; digest?: string | null; size?: number };
export type WindowsRelease = { draft: boolean; prerelease: boolean; tag_name: string; published_at: string; body?: string | null; assets: WindowsReleaseAsset[] };
export type WindowsUpdateManifest = { version: string; commit: string; platform: string; assetName: string; sha256: string; size: number };

function newer(version: string, current: string): boolean {
	if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d+\.\d+\.\d+$/.test(current)) { return false; }
	const next = version.split('.').map(Number); const before = current.split('.').map(Number);
	if (![...next, ...before].every(Number.isSafeInteger)) { return false; }
	for (let i = 0; i < next.length; i++) { if (next[i] !== before[i]) { return next[i] > before[i]; } }
	return false;
}

/** Only exact assets under a stable tag in the product repository are trusted. */
export function windowsReleaseAsset(release: WindowsRelease, name: string): WindowsReleaseAsset | undefined {
	if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) { return undefined; }
	const expected = 'https://github.com/ssadkov/arni-code/releases/download/' + release.tag_name + '/' + name;
	return release.assets.find(asset => asset.name === name && asset.browser_download_url === expected);
}

/** The Windows client must receive a digest-verified user installer and a newer version. */
export function windowsUpdate(release: WindowsRelease, manifest: WindowsUpdateManifest, commit: string, currentVersion: string) {
	if (manifest.platform !== 'win32-x64-user' || manifest.assetName !== 'ArniCodeSetup.exe'
		|| release.tag_name !== 'v' + manifest.version || !newer(manifest.version, currentVersion)
		|| !/^[a-f0-9]{40}$/.test(manifest.commit) || !/^[a-f0-9]{40}$/.test(commit) || manifest.commit === commit
		|| !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.size) || manifest.size <= 0) { return null; }
	const asset = windowsReleaseAsset(release, manifest.assetName);
	const timestamp = Date.parse(release.published_at);
	if (!asset || asset.digest !== 'sha256:' + manifest.sha256 || asset.size !== manifest.size || !Number.isFinite(timestamp)) { return null; }
	return { url: asset.browser_download_url, version: manifest.commit, productVersion: manifest.version,
		sha256hash: manifest.sha256, size: manifest.size, timestamp, releaseNotes: release.body || '' };
}
