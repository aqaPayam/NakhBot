import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  captureLaunchReviewRequest,
  LAUNCH_REVIEW_EVIDENCE,
  type LaunchReviewRequest,
} from './launch-review.js';

function denied(): never {
  throw new Error('Launch review files unavailable.');
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}
/** Hash private operator-supplied bytes. This proves content binding, not origin,
 * authenticity, provider success or a reviewer's acceptance of the contents. */
export async function loadLaunchReviewFiles(
  value: unknown,
  openEvidence: (path: string) => Promise<FileHandle> = (path) => open(path, 'r'),
): Promise<LaunchReviewRequest> {
  const input = object(structuredClone(value));
  if (!Array.isArray(input.evidence) || input.evidence.length > LAUNCH_REVIEW_EVIDENCE.length)
    denied();
  const evidenceInput = input.evidence;
  const paths = evidenceInput.map((value: unknown) => {
    const file = object(value);
    if (
      Object.keys(file).length !== 4 ||
      !['role', 'path', 'observedAt', 'expiresAt'].every((key) => Object.hasOwn(file, key)) ||
      typeof file.path !== 'string' ||
      !isAbsolute(file.path) ||
      file.path.length > 4096
    )
      denied();
    return file.path;
  });
  const captured = captureLaunchReviewRequest({
    ...input,
    evidence: evidenceInput.map((value: unknown) => {
      const file = object(value);
      return {
        role: file.role,
        sha256: '0'.repeat(64),
        observedAt: file.observedAt,
        expiresAt: file.expiresAt,
      };
    }),
  });
  const files = paths.map((path, index) => {
    const descriptor = captured.evidence.find(
      (entry) => entry.role === object(evidenceInput[index]).role,
    );
    if (!descriptor) denied();
    return { path, descriptor };
  });
  const evidence = [];
  for (const { path, descriptor } of files) {
    const file = await openEvidence(path);
    const buffer = Buffer.alloc(1048577);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > 1048576) denied();
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length === 0 || length > 1048576) denied();
      evidence.push({
        ...descriptor,
        sha256: createHash('sha256').update(buffer.subarray(0, length)).digest('hex'),
      });
    } finally {
      buffer.fill(0);
      await file.close();
    }
  }
  return captureLaunchReviewRequest({ ...captured, evidence });
}
