type ReleaseAsset = { name: string; browser_download_url: string; digest?: string | null };
export type MacRelease = { draft: boolean; prerelease: boolean; published_at: string; body?: string | null; assets: ReleaseAsset[] };
export type MacUpdateManifest = { version: string; commit: string; assetName: string; sha256: string; signed: boolean; notarized: boolean };

function newer(version: string, current: string): boolean {
	if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d+\.\d+\.\d+$/.test(current)) { return false; }
	const next = version.split('.').map(Number); const before = current.split('.').map(Number);
	for (let index = 0; index < next.length; index++) {
		if (next[index] !== before[index]) { return next[index] > before[index]; }
	}
	return false;
}

/** Only stable, explicitly notarized artifacts from the product repository enter the feed. */
export function macUpdate(release: MacRelease, manifest: MacUpdateManifest, arch: string, commit: string, currentVersion: string) {
	if (release.draft || release.prerelease || !manifest.signed || !manifest.notarized
		|| !/^[a-f0-9]{40}$/.test(manifest.commit) || manifest.commit === commit
		|| !/^[a-f0-9]{64}$/.test(manifest.sha256) || !newer(manifest.version, currentVersion)
		|| manifest.assetName !== `ArniCode-darwin-${arch}.zip`) { return null; }
	const asset = release.assets.find(asset => asset.name === manifest.assetName);
	if (!asset || !asset.browser_download_url.startsWith('https://github.com/ssadkov/arni-code/releases/download/')
		|| (asset.digest && asset.digest !== `sha256:${manifest.sha256}`)) { return null; }
	return { url: asset.browser_download_url, name: manifest.version, version: manifest.commit,
		productVersion: manifest.version, notes: release.body || '', pub_date: release.published_at,
		timestamp: Date.parse(release.published_at), sha256hash: manifest.sha256 };
}
