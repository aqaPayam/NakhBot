import { mkdir, writeFile } from 'node:fs/promises';
import { readReleaseCi, validateReleaseCiContext } from './release-ci.js';

try {
  const context = {
    repository: process.env.GITHUB_REPOSITORY ?? '',
    sha: process.env.NAKH_RELEASE_SHA ?? '',
    now: new Date(),
  };
  validateReleaseCiContext(context);
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Release CI credential unavailable.');
  const receipt = await readReleaseCi(context, async (path) => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'NakhBot-release-ci',
        'Cache-Control': 'no-cache',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('GitHub CI observation unavailable.');
    return response.json();
  });
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/release-ci.json', JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  console.log(
    `Release CI verified: ${receipt.sourceSha}, run ${receipt.runId}, attempt ${receipt.attempt}, six jobs.`,
  );
} catch {
  // Do not print API bodies, paths, errors, credentials or raw provider output.
  console.error('Release CI verification failed. No deployment is authorized.');
  process.exitCode = 1;
}
