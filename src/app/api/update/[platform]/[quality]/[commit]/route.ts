import { NextRequest } from 'next/server';
import { macUpdate, type MacRelease, type MacUpdateManifest } from '@/lib/macUpdates';
import { windowsUpdate, windowsReleaseAsset, type WindowsRelease, type WindowsUpdateManifest } from '@/lib/windowsUpdates';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ platform: string; quality: string; commit: string }> }) {
	const { platform, quality, commit } = await context.params;
	const arch = platform === 'darwin-arm64' ? 'arm64' : platform === 'darwin' ? 'x64' : undefined;
	const windows = platform === 'win32-x64-user';
	const currentVersion = /Code\/(\d+\.\d+\.\d+)/.exec(req.headers.get('user-agent') || '')?.[1];
	if ((!arch && !windows) || quality !== 'stable' || !/^[a-f0-9]{40}$/.test(commit) || !currentVersion) { return new Response(null, { status: 204 }); }
	try {
		const response = await fetch('https://api.github.com/repos/ssadkov/arni-code/releases/latest', {
			headers: { Accept: 'application/vnd.github+json' }, next: { revalidate: 300 }, signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) { return new Response(null, { status: 503 }); }
		const release = await response.json() as MacRelease & WindowsRelease;
		const asset = windows
			? windowsReleaseAsset(release, 'update-win32-x64.json')
			: release.assets.find(asset => asset.name === 'update-darwin-' + arch + '.json');
		if (!asset?.browser_download_url.startsWith('https://github.com/ssadkov/arni-code/releases/download/')) { return new Response(null, { status: 204 }); }
		const metadata = await fetch(asset.browser_download_url, { next: { revalidate: 300 }, signal: AbortSignal.timeout(15000) });
		if (!metadata.ok) { return new Response(null, { status: 503 }); }
		const manifest = await metadata.json();
		const update = windows
			? windowsUpdate(release, manifest as WindowsUpdateManifest, commit, currentVersion)
			: macUpdate(release, manifest as MacUpdateManifest, arch!, commit, currentVersion);
		return update ? Response.json(update, { headers: { 'Cache-Control': 'private, no-store' } }) : new Response(null, { status: 204 });
	} catch { return new Response(null, { status: 503 }); }
}
