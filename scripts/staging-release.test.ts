import { stagingContext } from './testing/staging-release-context.js';
import { describe, expect, it } from 'vitest';
import { RELEASE_SERVICES, type ReleaseService } from './release-images.js';
import {
  StagingRelease,
  captureStagingContext,
  stagingBootstrapAdmission,
  type StagingReleaseContext,
  type AwsReleaseCall,
  type ReleaseCustody,
  type ReleaseCapacity,
} from './staging-release.js';

type Raw = Record<string, unknown>;
function obj(value: unknown): Raw {
  return value as Raw;
}
function fixture(): {
  context: StagingReleaseContext;
  release: () => StagingRelease;
  records: Map<string, string>;
  calls: Array<{ operation: string; input: Raw }>;
  services: Map<ReleaseService, Raw>;
  targets: Map<ReleaseService, Raw>;
  tasks: Map<string, Raw>;
  omitted: Set<string>;
  aws: AwsReleaseCall;
  custody: ReleaseCustody;
  pause: () => Promise<void>;
  activate: (caps: Record<ReleaseService, ReleaseCapacity>, restored?: boolean) => void;
  clock: { now: number };
  fault: {
    put?: string;
    unknownRun?: boolean;
    bootstrap?: boolean;
    pendingRun?: boolean;
    badExit?: boolean;
    badDigest?: boolean;
    badDb?: boolean;
    badCommand?: boolean;
    badTasks?: boolean;
    listFailure?: boolean;
    scaleRace?: boolean;
    neverStop?: boolean;
    newTask?: boolean;
    targetFailure?: boolean;
  };
  definition: string;
} {
  const context = stagingContext(),
    clock = { now: 1800000000000 },
    records = new Map<string, string>(),
    calls: Array<{ operation: string; input: Raw }> = [];
  const services = new Map<ReleaseService, Raw>(),
    targets = new Map<ReleaseService, Raw>(),
    tasks = new Map<string, Raw>(),
    omitted = new Set<string>();
  const fault: {
    put?: string;
    unknownRun?: boolean;
    bootstrap?: boolean;
    pendingRun?: boolean;
    badExit?: boolean;
    badDigest?: boolean;
    badDb?: boolean;
    badCommand?: boolean;
    badTasks?: boolean;
    listFailure?: boolean;
    scaleRace?: boolean;
    neverStop?: boolean;
    newTask?: boolean;
    targetFailure?: boolean;
  } = {};
  const arn = (s: string): string => `arn:aws:ecs:${context.region}:${context.accountId}:${s}`;
  let counter = 1;
  const task = (name: ReleaseService, revision = 1): Raw => ({
    taskArn: arn('task/' + context.cluster + '/' + (counter++).toString(16).padStart(32, '0')),
    clusterArn: arn('cluster/' + context.cluster),
    taskDefinitionArn: arn('task-definition/' + context.cluster + '-' + name + ':' + revision),
    group: 'service:' + name,
    lastStatus: 'RUNNING',
    desiredStatus: 'RUNNING',
    containers: [
      {
        name,
        lastStatus: 'RUNNING',
        image: revision === 2 ? context.images[name] : 'old-image',
        imageDigest:
          revision === 2 ? context.images[name].split('@')[1] : 'sha256:' + 'b'.repeat(64),
      },
      { name: 'otel-collector', lastStatus: 'RUNNING' },
    ],
  });
  for (const name of RELEASE_SERVICES) {
    const taskDefinition = arn('task-definition/' + context.cluster + '-' + name + ':1');
    services.set(name, {
      serviceName: name,
      serviceArn: arn('service/' + context.cluster + '/' + name),
      clusterArn: arn('cluster/' + context.cluster),
      status: 'ACTIVE',
      taskDefinition,
      desiredCount: 2,
      runningCount: 2,
      pendingCount: 0,
      deployments: [{ taskDefinition, status: 'PRIMARY', rolloutState: 'COMPLETED' }],
    });
    targets.set(name, {
      ResourceId: `service/${context.cluster}/${name}`,
      ServiceNamespace: 'ecs',
      ScalableDimension: 'ecs:service:DesiredCount',
      MinCapacity: 2,
      MaxCapacity: 6,
      SuspendedState: {
        DynamicScalingInSuspended: name === 'worker',
        DynamicScalingOutSuspended: false,
        ScheduledScalingSuspended: name === 'api',
      },
    });
    for (let i = 0; i < 2; i++) {
      const t = task(name);
      tasks.set(String(t.taskArn), t);
    }
  }
  const custody: ReleaseCustody = {
    read: (key) => Promise.resolve(records.get(key)),
    put: async (key, body) => {
      await Promise.resolve();
      if (key.endsWith('/' + fault.put + '.json')) throw new Error('PRIVATE_CUSTODY_FAILURE');
      if (records.has(key)) {
        if (records.get(key) !== body) throw new Error('conflict');
        return 'existing';
      }
      records.set(key, body);
      return 'created';
    },
  };
  const definition = arn('task-definition/' + context.cluster + '-migration:2');
  const aws: AwsReleaseCall = async (_service, operation, input) => {
    await Promise.resolve();
    const p = structuredClone(input);
    calls.push({ operation, input: p });
    if (operation === 'describe-services')
      return { services: [...services.values()], failures: [] };
    if (operation === 'describe-scalable-targets') {
      if (fault.targetFailure) throw new Error('PRIVATE_AWS_FAILURE');
      return { ScalableTargets: [...targets.values()] };
    }
    if (operation === 'register-scalable-target') {
      expect([...records.keys()].some((k) => k.endsWith('/intent.json'))).toBe(true);
      const name = String(p.ResourceId).split('/').at(-1) as ReleaseService;
      Object.assign(targets.get(name)!, p);
      if (fault.scaleRace) {
        services.get('api')!.desiredCount = 4;
        fault.scaleRace = false;
      }
      return {};
    }
    if (operation === 'update-service') {
      expect(
        [...records.keys()].some((k) => k.endsWith('/held.json')) ||
          [...records.keys()].some((k) => k.endsWith('/intent.json')),
      ).toBe(true);
      const name = p.service as ReleaseService,
        s = services.get(name)!;
      s.desiredCount = p.desiredCount;
      s.runningCount = 0;
      s.pendingCount = 0;
      for (const t of tasks.values())
        if (t.group === 'service:' + name && t.lastStatus !== 'STOPPED') {
          t.desiredStatus = 'STOPPED';
          t.lastStatus = 'DEACTIVATING';
        }
      return {};
    }
    if (operation === 'list-tasks') {
      if (fault.listFailure) throw new Error('PRIVATE_LIST_FAILURE');
      return {
        taskArns: [...tasks.values()]
          .filter((t) => t.desiredStatus === p.desiredStatus && !omitted.has(String(t.taskArn)))
          .map((t) => t.taskArn),
      };
    }
    if (operation === 'describe-tasks')
      return {
        tasks: (p.tasks as string[]).map((id) => tasks.get(id)).filter(Boolean),
        failures: fault.badTasks ? [{ reason: 'MISSING' }] : [],
      };
    if (operation === 'describe-task-definition') {
      const selected = String(p.taskDefinition),
        name = selected
          .slice(selected.lastIndexOf('/') + 1)
          .replace(context.cluster + '-', '')
          .replace(/:\d+$/u, '') as ReleaseService | 'migration';
      const container = {
        name,
        image:
          fault.bootstrap && name !== 'migration'
            ? context.images[name].split('@')[0] + ':bootstrap'
            : context.images[name === 'migration' ? 'api' : name],
        essential: true,
        readonlyRootFilesystem: true,
        environment: [
          {
            name: 'NAKH_RELEASE',
            value: fault.bootstrap && name !== 'migration' ? 'bootstrap' : context.sourceSha,
          },
          { name: 'NAKH_ENV', value: 'staging' },
          { name: 'NAKH_SERVICE_NAME', value: name },
        ],
        secrets: [
          {
            name: 'NAKH_DATABASE_URL',
            valueFrom: (fault.badDb ? 'WRONG_SECRET' : context.secretArn) + ':NAKH_DATABASE_URL::',
          },
        ],
        ...(name === 'migration'
          ? { command: ['node', 'node_modules/@nakh/persistence-postgres/dist/cli/migrate.js'] }
          : {}),
      };
      return {
        taskDefinition: {
          taskDefinitionArn: selected,
          status: 'ACTIVE',
          networkMode: 'awsvpc',
          requiresCompatibilities: ['FARGATE'],
          containerDefinitions:
            name === 'migration' ? [container] : [container, { name: 'otel-collector' }],
        },
      };
    }
    if (operation === 'run-task') {
      if (fault.unknownRun) throw new Error('PRIVATE_UNKNOWN_RUN');
      const t: Raw = {
        taskArn: arn('task/' + context.cluster + '/' + (counter++).toString(16).padStart(32, '0')),
        clusterArn: arn('cluster/' + context.cluster),
        taskDefinitionArn: p.taskDefinition,
        group: 'nakh-one-off',
        desiredStatus: fault.pendingRun ? 'RUNNING' : 'STOPPED',
        lastStatus: fault.pendingRun ? 'RUNNING' : 'STOPPED',
        stopCode: 'EssentialContainerExited',
        startedBy: p.startedBy,
        overrides: fault.badCommand
          ? { containerOverrides: [{ name: 'migration', command: ['echo', '0'] }] }
          : p.overrides,
        containers: [
          {
            name: 'migration',
            lastStatus: fault.pendingRun ? 'RUNNING' : 'STOPPED',
            exitCode: fault.badExit ? 1 : 0,
            image: context.images.api,
            imageDigest: fault.badDigest
              ? 'sha256:' + '0'.repeat(64)
              : context.images.api.split('@')[1],
          },
        ],
      };
      tasks.set(String(t.taskArn), t);
      return { tasks: [t], failures: [] };
    }
    throw new Error('Unexpected AWS operation ' + operation);
  };
  const pause = async (): Promise<void> => {
    await Promise.resolve();
    if (fault.newTask) {
      const t = task('api');
      tasks.set(String(t.taskArn), t);
      fault.newTask = false;
    } else if (!fault.neverStop)
      for (const t of tasks.values())
        if (String(t.group).startsWith('service:') && t.desiredStatus === 'STOPPED') {
          t.lastStatus = 'STOPPED';
          t.desiredStatus = 'STOPPED';
          for (const c of t.containers as Raw[]) c.lastStatus = 'STOPPED';
        }
  };
  const activate = (caps: Record<ReleaseService, ReleaseCapacity>, restored = false): void => {
    for (const name of RELEASE_SERVICES) {
      const s = services.get(name)!,
        taskDefinition = arn('task-definition/' + context.cluster + '-' + name + ':2');
      Object.assign(s, {
        taskDefinition,
        desiredCount: caps[name].desired,
        runningCount: caps[name].desired,
        pendingCount: 0,
        deployments: [{ taskDefinition, status: 'PRIMARY', rolloutState: 'COMPLETED' }],
      });
      Object.assign(targets.get(name)!, {
        MinCapacity: restored ? caps[name].min : 0,
        MaxCapacity: caps[name].max,
        SuspendedState: restored
          ? caps[name].suspended
          : {
              DynamicScalingInSuspended: true,
              DynamicScalingOutSuspended: true,
              ScheduledScalingSuspended: true,
            },
      });
      for (let i = 0; i < caps[name].desired; i++) {
        const t = task(name, 2);
        tasks.set(String(t.taskArn), t);
      }
    }
  };
  return {
    context,
    clock,
    records,
    calls,
    services,
    targets,
    tasks,
    omitted,
    fault,
    definition,
    aws,
    custody,
    pause,
    activate,
    release: () => new StagingRelease(context, aws, custody, pause, () => clock.now),
  };
}

describe('actual staging release orchestration protocol', () => {
  it('requires explicit bootstrap, empty state and definitive absence of the exact named cluster', () => {
    const c = stagingContext(),
      base = {
        initialize: true,
        project: 'nakh',
        accountId: c.accountId,
        region: c.region,
        outputs: {},
        stateNames: '',
        clusters: { clusters: [], failures: [{ arn: c.cluster, reason: 'MISSING' }] },
      };
    expect(stagingBootstrapAdmission(base)).toBe(true);
    for (const change of [
      { initialize: false },
      { stateNames: 'aws_ecs_cluster.main' },
      { outputs: { unknown: { value: 0 } } },
      { clusters: { clusters: [], failures: [] } },
      { clusters: { clusters: [], failures: [{ arn: 'foreign-staging', reason: 'MISSING' }] } },
    ])
      expect(() => stagingBootstrapAdmission({ ...base, ...change })).toThrow();
    expect(
      stagingBootstrapAdmission({
        ...base,
        initialize: false,
        outputs: {
          ecs_cluster_name: { value: c.cluster },
          aws_account_id: { value: c.accountId },
          aws_region: { value: c.region },
        },
      }),
    ).toBe(false);
  });
  it('rejects scaling or service-definition drift after drain before running a migration', async () => {
    for (const kind of ['scaling', 'definition'] as const) {
      const f = fixture(),
        r = f.release();
      await r.drain();
      if (kind === 'scaling')
        obj(f.targets.get('worker')!.SuspendedState).DynamicScalingOutSuspended = false;
      else
        f.services.get('worker')!.taskDefinition = String(
          f.services.get('worker')!.taskDefinition,
        ).replace(':1', ':3');
      await expect(r.task('migration', f.definition)).rejects.toThrow();
      expect(f.calls.some((c) => c.operation === 'run-task')).toBe(false);
    }
  });
  it('rejects a running service with a wrong actual image digest before recording health', async () => {
    const f = fixture(),
      r = f.release();
    await r.drain();
    await r.task('compatibility', f.definition);
    f.activate(await r.admission());
    const current = [...f.tasks.values()].find((t) => t.lastStatus === 'RUNNING')!;
    (current.containers as Raw[])[0]!.imageDigest = 'sha256:' + '0'.repeat(64);
    await expect(r.healthy()).rejects.toThrow();
    expect(f.records.has(r.prefix + 'healthy.json')).toBe(false);
  });

  it('captures input before waits and rejects foreign scope before any provider command', () => {
    const f = fixture(),
      r = f.release();
    (f.context.images as Record<ReleaseService, string>).api = 'PRIVATE_MUTATION';
    expect(r.context.images.api).not.toBe('PRIVATE_MUTATION');
    expect(() => captureStagingContext({ ...stagingContext(), accountId: '000000000000' })).toThrow(
      'verification unavailable',
    );
    expect(f.calls).toEqual([]);
  });
  it('persists original policy before mutations, holds every scaling category before zero, and waits for physical stop', async () => {
    const f = fixture(),
      r = f.release();
    f.fault.scaleRace = true;
    await r.drain();
    const firstZero = f.calls.findIndex((c) => c.operation === 'update-service');
    expect(
      f.calls.slice(0, firstZero).filter((c) => c.operation === 'register-scalable-target'),
    ).toHaveLength(4);
    for (const call of f.calls.filter((c) => c.operation === 'register-scalable-target')) {
      expect(call.input.MinCapacity).toBe(0);
      expect(Object.values(obj(call.input.SuspendedState))).toEqual([true, true, true]);
    }
    expect([...f.tasks.values()].every((t) => t.lastStatus === 'STOPPED')).toBe(true);
    const held = JSON.parse(f.records.get(r.prefix + 'held.json')!) as {
      payload: Record<ReleaseService, ReleaseCapacity>;
    };
    expect(held.payload.api.desired).toBe(4);
    expect(held.payload.api.suspended.ScheduledScalingSuspended).toBe(true);
    expect(held.payload.worker.suspended.DynamicScalingInSuspended).toBe(true);
    await f.release().drain();
    expect(f.calls.filter((c) => c.operation === 'run-task')).toHaveLength(0);
  });
  it('never infers drain from service zero, an empty list, or desired STOPPED during shutdown', async () => {
    const f = fixture();
    f.fault.neverStop = true;
    for (const id of f.tasks.keys()) f.omitted.add(id);
    // Initial source inventory must include the tasks before later omission.
    f.omitted.clear();
    const first = f.aws;
    let lists = 0;
    const aws: AwsReleaseCall = async (s, o, p) => {
      const result = await first(s, o, p);
      if (o === 'list-tasks' && ++lists === 2) for (const id of f.tasks.keys()) f.omitted.add(id);
      return result;
    };
    await expect(
      new StagingRelease(f.context, aws, f.custody, f.pause, () => f.clock.now).drain(),
    ).rejects.toThrow('verification unavailable');
    expect([...f.records.keys()].some((k) => k.endsWith('/drained.json'))).toBe(false);
    expect(f.calls.filter((c) => c.operation === 'describe-tasks').length).toBeGreaterThan(1);
  });
  it('remembers a task first observed during drain across a fresh controller instance', async () => {
    const f = fixture();
    f.fault.newTask = true;
    f.fault.neverStop = true;
    await expect(f.release().drain()).rejects.toThrow();
    const extra = [...f.tasks.keys()].at(-1)!;
    f.omitted.add(extra);
    f.fault.neverStop = false;
    await f.release().drain();
    expect(
      f.calls.some(
        (c) => c.operation === 'describe-tasks' && (c.input.tasks as string[]).includes(extra),
      ),
    ).toBe(true);
    expect(f.tasks.get(extra)?.lastStatus).toBe('STOPPED');
  });
  it('denies unknown active producers and provider failures without claiming drain', async () => {
    for (const kind of ['unknown', 'list', 'missing'] as const) {
      const f = fixture();
      if (kind === 'unknown') [...f.tasks.values()][0]!.group = 'unknown-producer';
      if (kind === 'list') f.fault.listFailure = true;
      if (kind === 'missing') f.fault.badTasks = true;
      await expect(f.release().drain()).rejects.toThrow();
      expect(f.calls.some((c) => c.operation === 'update-service')).toBe(false);
    }
  });
  it('does not change services if intent or pre-zero custody cannot be verified', async () => {
    for (const phase of ['intent', 'held']) {
      const f = fixture();
      f.fault.put = phase;
      await expect(f.release().drain()).rejects.toThrow();
      expect(f.calls.some((c) => c.operation === 'update-service')).toBe(false);
    }
  });
  it('runs one private pinned migration and one native schema task; exact replay never runs another task', async () => {
    const f = fixture(),
      r = f.release();
    await r.drain();
    await r.task('migration', f.definition);
    await r.task('compatibility', f.definition);
    await f.release().task('compatibility', f.definition);
    const runs = f.calls.filter((c) => c.operation === 'run-task');
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.input.clientToken).toMatch(/^[a-f0-9]{64}$/u);
      expect(run.input.count).toBe(1);
      expect(obj(obj(run.input.networkConfiguration).awsvpcConfiguration).assignPublicIp).toBe(
        'DISABLED',
      );
    }
    expect(
      runs.map((v) => obj((obj(v.input.overrides).containerOverrides as Raw[])[0]).command),
    ).toEqual([
      ['node', 'node_modules/@nakh/persistence-postgres/dist/cli/migrate.js'],
      ['node', 'node_modules/@nakh/persistence-postgres/dist/cli/compatibility.js'],
    ]);
  });
  it('never retries an uncertain RunTask outcome or invents a successful native check', async () => {
    const f = fixture(),
      r = f.release();
    await r.drain();
    f.fault.unknownRun = true;
    await expect(r.task('compatibility', f.definition)).rejects.toThrow();
    f.fault.unknownRun = false;
    await expect(f.release().task('compatibility', f.definition)).rejects.toThrow();
    expect(f.calls.filter((c) => c.operation === 'run-task')).toHaveLength(1);
    await expect(r.admission()).rejects.toThrow();
    expect(f.records.has(r.prefix + 'compatibility-prepared.json')).toBe(true);
  });
  it('allows only one task start when two controllers claim the same operation concurrently', async () => {
    const f = fixture();
    await f.release().drain();
    const result = await Promise.allSettled([
      f.release().task('compatibility', f.definition),
      f.release().task('compatibility', f.definition),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(f.calls.filter((c) => c.operation === 'run-task')).toHaveLength(1);
  });
  it('rejects wrong exit, actual image digest, command or database binding', async () => {
    for (const kind of ['badExit', 'badDigest', 'badCommand', 'badDb'] as const) {
      const f = fixture(),
        r = f.release();
      await r.drain();
      f.fault[kind] = true;
      await expect(r.task('compatibility', f.definition)).rejects.toThrow();
      await expect(r.admission()).rejects.toThrow();
    }
  });
  it('requires a fresh successful native check and still-current physical drain before activation', async () => {
    const f = fixture(),
      r = f.release();
    await r.drain();
    await r.task('compatibility', f.definition);
    expect((await r.admission()).api.desired).toBe(2);
    f.clock.now += 300001;
    await expect(r.admission()).rejects.toThrow();
    f.clock.now -= 300001;
    f.services.get('worker')!.desiredCount = 1;
    await expect(r.admission()).rejects.toThrow();
  });
  it('requires every selected service task healthy before restoring the exact operator suspensions', async () => {
    const f = fixture(),
      r = f.release();
    await r.drain();
    await r.task('compatibility', f.definition);
    const caps = await r.admission();
    f.activate(caps);
    await r.healthy();
    for (const n of RELEASE_SERVICES)
      Object.assign(f.targets.get(n)!, {
        MinCapacity: caps[n].min,
        SuspendedState: caps[n].suspended,
      });
    await f.release().healthy(true);
    expect(f.records.has(r.prefix + 'activated.json')).toBe(true);
    f.targets.get('api')!.SuspendedState = {
      DynamicScalingInSuspended: false,
      DynamicScalingOutSuspended: false,
      ScheduledScalingSuspended: false,
    };
    await expect(f.release().healthy(true)).rejects.toThrow();
  });
  it('recovers original capacity from protected intent rather than copying maintenance zero or all-held flags', async () => {
    const f = fixture(),
      r = f.release();
    f.fault.scaleRace = true;
    await r.drain();
    const next = new StagingRelease(
      { ...f.context, runId: '124' },
      f.aws,
      f.custody,
      f.pause,
      () => f.clock.now,
    );
    await expect(next.drain()).rejects.toThrow();
    await next.drain(r.prefix + 'intent.json');
    await next.task('compatibility', f.definition);
    const caps = await next.admission();
    expect(caps.api.desired).toBe(4);
    expect(caps.api.suspended.ScheduledScalingSuspended).toBe(true);
    expect(caps.scheduler.suspended.ScheduledScalingSuspended).toBe(false);
  });
  it('keeps failed activation off even when the current task definitions changed or scaling reads fail', async () => {
    const f = fixture(),
      r = f.release();
    await r.drain();
    await r.task('compatibility', f.definition);
    f.activate(await r.admission());
    await r.maintain();
    expect([...f.services.values()].every((s) => s.desiredCount === 0)).toBe(true);
    f.fault.targetFailure = true;
    for (const s of f.services.values()) s.desiredCount = 2;
    await expect(r.maintain()).rejects.toThrow();
    expect([...f.services.values()].every((s) => s.desiredCount === 0)).toBe(true);
  });
  it('denies repeated pagination tokens instead of accepting a partial task inventory', async () => {
    const f = fixture();
    const aws: AwsReleaseCall = (service, operation, input) =>
      operation === 'list-tasks'
        ? Promise.resolve({ taskArns: [], nextToken: 'same-token' })
        : f.aws(service, operation, input);
    await expect(
      new StagingRelease(f.context, aws, f.custody, f.pause, () => f.clock.now).drain(),
    ).rejects.toThrow();
    expect(f.calls.some((c) => c.operation === 'update-service')).toBe(false);
  });
  it('resumes the exact durably known running one-off task without restarting or stopping it', async () => {
    const f = fixture(),
      r = f.release();
    await r.drain();
    f.fault.pendingRun = true;
    await expect(r.task('compatibility', f.definition)).rejects.toThrow();
    expect(f.records.has(r.prefix + 'compatibility-started.json')).toBe(true);
    await expect(r.maintain()).rejects.toThrow();
    expect([...f.services.values()].every((s) => s.desiredCount === 0)).toBe(true);
    const pause = async (): Promise<void> => {
      await f.pause();
      for (const t of f.tasks.values())
        if (t.group === 'nakh-one-off') {
          t.lastStatus = 'STOPPED';
          t.desiredStatus = 'STOPPED';
          for (const c of t.containers as Raw[]) c.lastStatus = 'STOPPED';
        }
    };
    await new StagingRelease(f.context, f.aws, f.custody, pause, () => f.clock.now).task(
      'compatibility',
      f.definition,
    );
    expect(f.calls.filter((c) => c.operation === 'run-task')).toHaveLength(1);
    expect(f.calls.some((c) => c.operation === 'stop-task')).toBe(false);
  });
  it('admits an actually inactive bootstrap fleet without inventing a previous scaling policy', async () => {
    const f = fixture(),
      r = f.release();
    f.targets.clear();
    f.tasks.clear();
    f.fault.bootstrap = true;
    for (const s of f.services.values()) {
      s.desiredCount = 0;
      s.runningCount = 0;
      s.pendingCount = 0;
    }
    await r.drain();
    await r.task('compatibility', f.definition);
    expect((await r.admission()).api.suspended.ScheduledScalingSuspended).toBe(false);
  });
  it('recovers partially created scaling targets only with the original protected policy', async () => {
    for (const removed of [3, 4]) {
      const f = fixture(),
        r = f.release();
      await r.drain();
      for (const name of RELEASE_SERVICES.slice(0, removed)) f.targets.delete(name);
      const next = new StagingRelease(
        { ...f.context, runId: '125' },
        f.aws,
        f.custody,
        f.pause,
        () => f.clock.now,
      );
      await expect(next.drain()).rejects.toThrow();
      await next.drain(r.prefix + 'intent.json');
      await next.task('compatibility', f.definition);
      const caps = await next.admission();
      expect(caps.api.min).toBe(2);
      expect(caps.api.suspended.ScheduledScalingSuspended).toBe(true);
    }
  });
  it('waits for bounded scaling-state convergence without treating stale reads as held or restored', async () => {
    const f = fixture(),
      before = structuredClone([...f.targets.values()]);
    let initial = true,
      staleRestore: Raw[] | undefined;
    const aws: AwsReleaseCall = (service, operation, input) => {
      if (operation === 'describe-scalable-targets') {
        if (
          initial &&
          f.calls.filter((c) => c.operation === 'register-scalable-target').length === 4
        ) {
          initial = false;
          return Promise.resolve({ ScalableTargets: before });
        }
        if (staleRestore) {
          const value = staleRestore;
          staleRestore = undefined;
          return Promise.resolve({ ScalableTargets: value });
        }
      }
      return f.aws(service, operation, input);
    };
    const r = new StagingRelease(f.context, aws, f.custody, f.pause, () => f.clock.now);
    await r.drain();
    await r.task('compatibility', f.definition);
    const caps = await r.admission();
    f.activate(caps);
    await r.healthy();
    staleRestore = structuredClone([...f.targets.values()]);
    for (const n of RELEASE_SERVICES)
      Object.assign(f.targets.get(n)!, {
        MinCapacity: caps[n].min,
        SuspendedState: caps[n].suspended,
      });
    await r.healthy(true);
    expect(f.records.has(r.prefix + 'activated.json')).toBe(true);
  });
  it('waits for eventual visibility of only its exact durably started task without invoking another task', async () => {
    const f = fixture();
    let missing = true;
    const aws: AwsReleaseCall = (service, operation, input) => {
      if (operation === 'describe-tasks' && (input.tasks as string[]).length === 1 && missing) {
        const id = (input.tasks as string[])[0]!;
        if (f.tasks.get(id)?.group === 'nakh-one-off') {
          missing = false;
          return Promise.resolve({ tasks: [], failures: [{ arn: id, reason: 'MISSING' }] });
        }
      }
      return f.aws(service, operation, input);
    };
    const r = new StagingRelease(f.context, aws, f.custody, f.pause, () => f.clock.now);
    await r.drain();
    await r.task('compatibility', f.definition);
    expect(missing).toBe(false);
    expect(f.calls.filter((c) => c.operation === 'run-task')).toHaveLength(1);
    expect((await r.admission()).api.desired).toBe(2);
  });
  it('denies a corrupted durable receipt instead of treating it as a fresh release', async () => {
    const f = fixture(),
      r = f.release();
    await r.drain();
    const raw = JSON.parse(f.records.get(r.prefix + 'intent.json')!) as { payloadHash: string };
    raw.payloadHash = '0'.repeat(64);
    f.records.set(r.prefix + 'intent.json', JSON.stringify(raw));
    await expect(f.release().drain()).rejects.toThrow();
  });
});
