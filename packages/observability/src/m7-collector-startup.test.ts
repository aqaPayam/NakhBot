import { describe, expect, it } from 'vitest';
import { classifyCollectorStartupFailure, pullCollectorImage } from './m7-collector-startup.js';

describe('privacy-safe bounded collector image startup', () => {
  it.each([
    ['503 Service Unavailable', 'collector_registry_transient', true],
    ['429 Too Many Requests', 'collector_registry_transient', true],
    ['TLS handshake timeout', 'collector_registry_transient', true],
    ['read: connection reset by peer', 'collector_registry_transient', true],
    ['manifest unknown', 'collector_image_missing', false],
    ['401 unauthorized', 'collector_registry_denied', false],
    ['403 access denied after connection reset', 'collector_registry_denied', false],
    ['port is already allocated', 'collector_runtime_collision', false],
    ['Cannot connect to the Docker daemon', 'collector_runtime_unavailable', false],
    ['unrecognized private diagnostic', 'collector_startup_unknown', false],
  ])('classifies %s without copying diagnostics', (diagnostic, code, retryable) => {
    const result = classifyCollectorStartupFailure({
      stderr: `${diagnostic}; private-marker Authorization=private-bearer`,
      stdout: 'private-payload',
    });
    expect(result).toEqual({ code, retryable });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('recognizes executable and timeout failures using fixed metadata', () => {
    expect(classifyCollectorStartupFailure({ code: 'ENOENT', stderr: 'private' })).toEqual({
      code: 'collector_runtime_unavailable',
      retryable: false,
    });
    expect(classifyCollectorStartupFailure({ killed: true, stderr: 'private' })).toEqual({
      code: 'collector_registry_transient',
      retryable: true,
    });
    expect(classifyCollectorStartupFailure('private')).toEqual({
      code: 'collector_startup_unknown',
      retryable: false,
    });
  });
  it('recovers a recognized transient pull with at most three attempts', async () => {
    let attempts = 0;
    const waits: number[] = [];
    await pullCollectorImage(
      () => {
        if (++attempts < 3)
          return Promise.reject(
            Object.assign(new Error('Collector startup fixture'), {
              stderr: '503 Service Unavailable',
            }),
          );
        return Promise.resolve();
      },
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    );
    expect(attempts).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });
  it('fails closed immediately for denied, missing and unknown images', async () => {
    for (const stderr of ['403 access denied', 'manifest unknown', 'private unknown diagnostic']) {
      let attempts = 0;
      const failure = Object.assign(new Error('Collector startup fixture'), { stderr }),
        waits: number[] = [];
      await expect(
        pullCollectorImage(
          () => {
            attempts++;
            return Promise.reject(failure);
          },
          (ms) => {
            waits.push(ms);
            return Promise.resolve();
          },
        ),
      ).rejects.toBe(failure);
      expect(attempts).toBe(1);
      expect(waits).toEqual([]);
    }
  });
  it('stops after three transient failures instead of hiding a broken dependency', async () => {
    let attempts = 0;
    const failure = Object.assign(new Error('Collector startup fixture'), {
        stderr: 'connection reset',
      }),
      waits: number[] = [];
    await expect(
      pullCollectorImage(
        () => {
          attempts++;
          return Promise.reject(failure);
        },
        (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      ),
    ).rejects.toBe(failure);
    expect(attempts).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });
});
