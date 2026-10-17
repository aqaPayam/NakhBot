import { mkdir, writeFile } from 'node:fs/promises';
import { readReleaseCi, readReleaseCiStatus, validateReleaseCiContext } from './release-ci.js';

try {
  const args = process.argv.slice(2),
    statusOnly = args.length === 1 && args[0] === '--archive-status';
  if (args.length !== 0 && !statusOnly) throw new Error('Invalid invocation.');
  if (
    statusOnly &&
    !/^archives\/[a-f0-9]{40}\/[1-9][0-9]{0,19}\/[1-9][0-9]{0,8}\/manifest\.json$/u.test(
      process.env.RELEASE_ARCHIVE_REF ?? '',
    )
  )
    throw new Error('Archive reference missing.');
  const context = {
    repository: process.env.GITHUB_REPOSITORY ?? '',
    sha: process.env.NAKH_RELEASE_SHA ?? '',
    now: new Date(),
  };
  validateReleaseCiContext(context);
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Release CI credential unavailable.');
  const receipt = await (statusOnly ? readReleaseCiStatus : readReleaseCi)(
    context,
    async (path) => {
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
    },
  );
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    statusOnly ? 'artifacts/release-ci-status.json' : 'artifacts/release-ci.json',
    JSON.stringify(receipt, null, 2) + '\n',
    'utf8',
  );
  if (statusOnly)
    console.log(
      'Selected-source CI status verified. Signed archive verification is still required.',
    );
  else
    console.log(
      `Release CI verified: ${receipt.sourceSha}, run ${receipt.runId}, attempt ${receipt.attempt}, six jobs.`,
    );
} catch {
  // Do not print API bodies, paths, errors, credentials or raw provider output.
  console.error('Release CI verification failed. No deployment is authorized.');
  process.exitCode = 1;
}
