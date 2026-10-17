import { createHash } from 'node:crypto';
import { RELEASE_SERVICES, type ReleaseService } from './release-images.js';

export type AwsReleaseCall = (
  service: 'ecs' | 'application-autoscaling',
  operation: string,
  input: Readonly<Record<string, unknown>>,
) => Promise<unknown>;
export type ReleaseCustody = Readonly<{
  read: (key: string) => Promise<string | undefined>;
  put: (key: string, body: string) => Promise<'created' | 'existing'>;
}>;
type Suspension = {
  DynamicScalingInSuspended: boolean;
  DynamicScalingOutSuspended: boolean;
  ScheduledScalingSuspended: boolean;
};
export type ReleaseCapacity = {
  desired: number;
  min: number;
  max: number;
  suspended: Suspension;
};
export type StagingReleaseContext = Readonly<{
  sourceSha: string;
  controllerSha: string;
  archive: Readonly<{ key: string; sha256: string }> | null;
  repository: string;
  accountId: string;
  region: string;
  cluster: string;
  runId: string;
  attempt: number;
  images: Readonly<Record<ReleaseService, string>>;
  defaultMin: number;
  defaultMax: number;
  secretArn: string;
  subnets: readonly string[];
  securityGroup: string;
  bucket: string;
}>;
type ServiceState = {
  name: ReleaseService;
  taskDefinition: string;
  desired: number;
  running: number;
  pending: number;
  stable: boolean;
};
type Target = { name: ReleaseService; min: number; max: number; suspended: Suspension };
type Intent = {
  services: Array<{
    name: ReleaseService;
    taskDefinition: string;
    hadTarget: boolean;
    capacity: ReleaseCapacity;
  }>;
  taskArns: string[];
  recoveryFrom: string | null;
};
type TaskKind = 'migration' | 'compatibility';
const HOLD: Suspension = {
  DynamicScalingInSuspended: true,
  DynamicScalingOutSuspended: true,
  ScheduledScalingSuspended: true,
};
const RESUME: Suspension = {
  DynamicScalingInSuspended: false,
  DynamicScalingOutSuspended: false,
  ScheduledScalingSuspended: false,
};
function denied(): never {
  throw new Error(
    'Staging release verification unavailable. Keep maintenance until reviewed recovery.',
  );
}
export function releaseHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1000) denied();
  return value as unknown[];
}
function count(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > 100) denied();
  return Number(value);
}
function suspension(value: unknown): Suspension {
  const data = record(value);
  if (Object.keys(data).sort().join(',') !== Object.keys(HOLD).sort().join(',')) denied();
  for (const key of Object.keys(HOLD)) if (typeof data[key] !== 'boolean') denied();
  return {
    DynamicScalingInSuspended: data.DynamicScalingInSuspended as boolean,
    DynamicScalingOutSuspended: data.DynamicScalingOutSuspended as boolean,
    ScheduledScalingSuspended: data.ScheduledScalingSuspended as boolean,
  };
}
function capacity(value: unknown): ReleaseCapacity {
  const data = record(value),
    min = count(data.min, 2),
    max = count(data.max, min);
  const desired = count(data.desired, min);
  if (desired > max) denied();
  return { desired, min, max, suspended: suspension(data.suspended) };
}
function partition(region: string): string {
  return region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
}

export function stagingBootstrapAdmission(
  input: Readonly<{
    initialize: boolean;
    project: string;
    accountId: string;
    region: string;
    outputs: unknown;
    stateNames: string;
    clusters?: unknown;
  }>,
): boolean {
  const { initialize, project, accountId, region } = input,
    outputs = record(input.outputs);
  if (
    typeof initialize !== 'boolean' ||
    !/^[a-z][a-z0-9-]{1,19}$/u.test(project) ||
    !/^[0-9]{12}$/u.test(accountId) ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/u.test(region)
  )
    denied();
  if (!initialize) {
    if (
      record(outputs.ecs_cluster_name).value !== project + '-staging' ||
      record(outputs.aws_account_id).value !== accountId ||
      record(outputs.aws_region).value !== region
    )
      denied();
    return false;
  }
  if (Object.keys(outputs).length !== 0 || input.stateNames.trim() !== '') denied();
  const response = record(input.clusters),
    failures = array(response.failures);
  if (array(response.clusters).length !== 0 || failures.length !== 1) denied();
  const missing = record(failures[0]);
  if (
    missing.reason !== 'MISSING' ||
    ![
      project + '-staging',
      `arn:${partition(region)}:ecs:${region}:${accountId}:cluster/${project}-staging`,
    ].includes(String(missing.arn))
  )
    denied();
  return true;
}
export function captureStagingContext(input: StagingReleaseContext): StagingReleaseContext {
  const c = structuredClone(input);
  if (
    !/^[a-f0-9]{40}$/u.test(c.sourceSha) ||
    !/^[a-f0-9]{40}$/u.test(c.controllerSha) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(c.repository) ||
    !/^[0-9]{12}$/u.test(c.accountId) ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/u.test(c.region) ||
    !/^[a-z][a-z0-9-]{1,19}-staging$/u.test(c.cluster) ||
    !/^[1-9][0-9]{0,19}$/u.test(c.runId) ||
    !Number.isSafeInteger(c.attempt) ||
    c.attempt < 1 ||
    c.attempt > 999999999
  )
    denied();
  if (
    c.archive !== null &&
    (!new RegExp(
      '^archives/' + c.sourceSha + '/[1-9][0-9]{0,19}/[1-9][0-9]{0,8}/manifest\\.json$',
      'u',
    ).test(c.archive.key) ||
      !/^[a-f0-9]{64}$/u.test(c.archive.sha256))
  )
    denied();
  count(c.defaultMin, 2);
  count(c.defaultMax, c.defaultMin);
  if (Object.keys(record(c.images)).sort().join(',') !== [...RELEASE_SERVICES].sort().join(','))
    denied();
  const images = {} as Record<ReleaseService, string>;
  for (const name of RELEASE_SERVICES) {
    const prefix = `${c.accountId}.dkr.ecr.${c.region}.amazonaws.com${c.region.startsWith('cn-') ? '.cn' : ''}/${c.cluster}/${name}@sha256:`;
    if (
      !c.images[name].startsWith(prefix) ||
      !/^[a-f0-9]{64}$/u.test(c.images[name].slice(prefix.length))
    )
      denied();
    images[name] = c.images[name];
  }
  const subnets = array(c.subnets).map((s) => {
    if (typeof s !== 'string') denied();
    return s;
  });
  if (
    !c.secretArn.startsWith(
      `arn:${partition(c.region)}:secretsmanager:${c.region}:${c.accountId}:secret:${c.cluster}/runtime-`,
    ) ||
    !/^[A-Za-z0-9:/_-]{1,2048}$/u.test(c.secretArn) ||
    subnets.length !== 2 ||
    new Set(subnets).size !== 2 ||
    subnets.some((s) => !/^subnet-[a-f0-9]{8,17}$/u.test(s)) ||
    !/^sg-[a-f0-9]{8,17}$/u.test(c.securityGroup) ||
    c.bucket !==
      `${c.cluster}-release-${createHash('sha256')
        .update(c.accountId + ':' + c.region)
        .digest('hex')
        .slice(0, 16)}`
  )
    denied();
  return {
    sourceSha: c.sourceSha,
    controllerSha: c.controllerSha,
    archive: c.archive === null ? null : { ...c.archive },
    repository: c.repository,
    accountId: c.accountId,
    region: c.region,
    cluster: c.cluster,
    runId: c.runId,
    attempt: c.attempt,
    images,
    defaultMin: c.defaultMin,
    defaultMax: c.defaultMax,
    secretArn: c.secretArn,
    subnets: subnets.sort(),
    securityGroup: c.securityGroup,
    bucket: c.bucket,
  };
}

/** Fixed staging fleet only. AWS protocol tests are separate from real-provider acceptance. */
export class StagingRelease {
  readonly context: StagingReleaseContext;
  private readonly observedTasks = new Set<string>();
  private observationIndex = 0;
  private observedHash = releaseHash([]);
  private async loadObservations(): Promise<void> {
    for (; this.observationIndex < 100; this.observationIndex++) {
      const saved = await this.read('observed-' + this.observationIndex);
      if (!saved) return;
      const ids = array(record(saved.payload).taskArns).map((v) => this.taskArn(v));
      if (
        new Set(ids).size !== ids.length ||
        [...this.observedTasks].some((id) => !ids.includes(id))
      )
        denied();
      for (const id of ids) this.observedTasks.add(id);
      this.observedHash = releaseHash([...this.observedTasks].sort());
    }
    denied();
  }
  private async observe(): Promise<void> {
    const ids = [...this.observedTasks].sort();
    if (releaseHash(ids) === this.observedHash) return;
    if (this.observationIndex >= 100) denied();
    await this.save('observed-' + this.observationIndex, { taskArns: ids });
    this.observationIndex++;
    this.observedHash = releaseHash(ids);
  }
  constructor(
    input: StagingReleaseContext,
    private readonly aws: AwsReleaseCall,
    private readonly custody: ReleaseCustody,
    private readonly pause: () => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {
    this.context = captureStagingContext(input);
  }
  get prefix(): string {
    const c = this.context;
    return `releases/${c.sourceSha}/${c.runId}/${c.attempt}/`;
  }
  private arn(resource: string): string {
    const c = this.context;
    return `arn:${partition(c.region)}:ecs:${c.region}:${c.accountId}:${resource}`;
  }
  private definition(value: unknown, name: string): string {
    const prefix = this.arn(`task-definition/${this.context.cluster}-${name}:`);
    if (
      typeof value !== 'string' ||
      !value.startsWith(prefix) ||
      !/^[1-9][0-9]{0,9}$/u.test(value.slice(prefix.length))
    )
      denied();
    return value;
  }
  private taskArn(value: unknown): string {
    const prefix = this.arn(`task/${this.context.cluster}/`);
    if (
      typeof value !== 'string' ||
      !value.startsWith(prefix) ||
      !/^[a-f0-9]{32}$/u.test(value.slice(prefix.length))
    )
      denied();
    return value;
  }
  private async call(
    service: Parameters<AwsReleaseCall>[0],
    op: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      return record(await this.aws(service, op, structuredClone(input)));
    } catch {
      denied();
    }
  }
  private async read(phase: string): Promise<Record<string, unknown> | undefined> {
    const raw = await this.custody.read(this.prefix + phase + '.json');
    if (raw === undefined) return undefined;
    return this.decode(raw, this.context);
  }
  private decode(raw: string, expected?: StagingReleaseContext): Record<string, unknown> {
    if (Buffer.byteLength(raw) > 262144) denied();
    let envelope: Record<string, unknown>;
    try {
      envelope = record(JSON.parse(raw) as unknown);
    } catch {
      denied();
    }
    const context = captureStagingContext(envelope.context as StagingReleaseContext);
    if (
      envelope.format !== 2 ||
      typeof envelope.observedAt !== 'number' ||
      !Number.isSafeInteger(envelope.observedAt) ||
      typeof envelope.payloadHash !== 'string' ||
      releaseHash(envelope.payload) !== envelope.payloadHash ||
      (expected && releaseHash(context) !== releaseHash(expected))
    )
      denied();
    return envelope;
  }
  private async save(phase: string, payload: unknown): Promise<'created' | 'existing'> {
    const body = JSON.stringify({
      format: 2,
      context: this.context,
      observedAt: this.now(),
      payloadHash: releaseHash(payload),
      payload,
    });
    if (Buffer.byteLength(body) > 262144) denied();
    const existing = await this.read(phase);
    if (existing) {
      if (existing.payloadHash !== releaseHash(payload)) denied();
      return 'existing';
    }
    const result = await this.custody.put(this.prefix + phase + '.json', body);
    const observed = await this.read(phase);
    if (!observed || observed.payloadHash !== releaseHash(payload)) denied();
    return result;
  }
  private parseIntent(envelope: Record<string, unknown>): Intent {
    const p = record(envelope.payload),
      rows = array(p.services);
    if (
      rows.length !== 4 ||
      (p.recoveryFrom !== null &&
        (typeof p.recoveryFrom !== 'string' ||
          !/^releases\/[a-f0-9]{40}\/[1-9][0-9]{0,19}\/[1-9][0-9]{0,8}\/intent\.json$/u.test(
            p.recoveryFrom,
          )))
    )
      denied();
    const services = RELEASE_SERVICES.map((name) => {
      const matches = rows.map(record).filter((s) => s.name === name);
      if (matches.length !== 1) denied();
      const s = matches[0]!;
      if (typeof s.hadTarget !== 'boolean') denied();
      return {
        name,
        taskDefinition: this.definition(s.taskDefinition, name),
        hadTarget: s.hadTarget,
        capacity: capacity(s.capacity),
      };
    });
    const taskArns = array(p.taskArns).map((a) => this.taskArn(a));
    if (new Set(taskArns).size !== taskArns.length) denied();
    return { services, taskArns, recoveryFrom: p.recoveryFrom };
  }
  private async intent(): Promise<Intent> {
    const value = await this.read('intent');
    if (!value) denied();
    return this.parseIntent(value);
  }
  private async services(): Promise<ServiceState[]> {
    const c = this.context,
      data = await this.call('ecs', 'describe-services', {
        cluster: c.cluster,
        services: RELEASE_SERVICES,
      });
    if (data.failures !== undefined && array(data.failures).length !== 0) denied();
    const rows = array(data.services).map(record);
    if (rows.length !== 4) denied();
    return RELEASE_SERVICES.map((name) => {
      const found = rows.filter((s) => s.serviceName === name);
      if (found.length !== 1) denied();
      const s = found[0]!;
      if (
        s.serviceArn !== this.arn(`service/${c.cluster}/${name}`) ||
        s.clusterArn !== this.arn(`cluster/${c.cluster}`) ||
        s.status !== 'ACTIVE'
      )
        denied();
      const deployments = array(s.deployments).map(record);
      return {
        name,
        taskDefinition: this.definition(s.taskDefinition, name),
        desired: count(s.desiredCount),
        running: count(s.runningCount),
        pending: count(s.pendingCount),
        stable:
          deployments.length === 1 &&
          deployments[0]?.status === 'PRIMARY' &&
          deployments[0]?.rolloutState === 'COMPLETED' &&
          deployments[0]?.taskDefinition === s.taskDefinition,
      };
    });
  }
  private async targets(): Promise<Target[]> {
    const c = this.context,
      data = await this.call('application-autoscaling', 'describe-scalable-targets', {
        ServiceNamespace: 'ecs',
        ScalableDimension: 'ecs:service:DesiredCount',
        ResourceIds: RELEASE_SERVICES.map((n) => `service/${c.cluster}/${n}`),
      });
    if (data.NextToken !== undefined) denied();
    const rows = array(data.ScalableTargets).map(record);
    if (rows.length > 4) denied();
    const targets = rows.map((t) => {
      const name = RELEASE_SERVICES.find((n) => t.ResourceId === `service/${c.cluster}/${n}`);
      if (
        !name ||
        t.ServiceNamespace !== 'ecs' ||
        t.ScalableDimension !== 'ecs:service:DesiredCount'
      )
        denied();
      return {
        name,
        min: count(t.MinCapacity),
        max: count(t.MaxCapacity, 2),
        suspended: suspension(t.SuspendedState),
      };
    });
    if (new Set(targets.map((t) => t.name)).size !== targets.length) denied();
    return targets;
  }
  private async setTarget(target: Target, held: boolean): Promise<void> {
    await this.call('application-autoscaling', 'register-scalable-target', {
      ServiceNamespace: 'ecs',
      ScalableDimension: 'ecs:service:DesiredCount',
      ResourceId: `service/${this.context.cluster}/${target.name}`,
      MinCapacity: held ? 0 : target.min,
      MaxCapacity: target.max,
      SuspendedState: held ? HOLD : target.suspended,
    });
  }
  private async tasks(
    remembered: readonly string[] = [],
    allowedStandalone?: string,
  ): Promise<Record<string, unknown>[]> {
    const ids = new Set([...remembered, ...this.observedTasks].map((a) => this.taskArn(a)));
    for (const desiredStatus of ['RUNNING', 'STOPPED']) {
      let nextToken: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; ; page++) {
        if (page >= 10) denied();
        const data = await this.call('ecs', 'list-tasks', {
          cluster: this.context.cluster,
          desiredStatus,
          maxResults: 100,
          ...(nextToken ? { nextToken } : {}),
        });
        for (const id of array(data.taskArns)) ids.add(this.taskArn(id));
        if (ids.size > 1000) denied();
        if (data.nextToken === undefined) break;
        if (
          typeof data.nextToken !== 'string' ||
          data.nextToken.length === 0 ||
          data.nextToken.length > 4096 ||
          seen.has(data.nextToken)
        )
          denied();
        seen.add(data.nextToken);
        nextToken = data.nextToken;
      }
    }
    const list = [...ids],
      tasks: Record<string, unknown>[] = [];
    for (let offset = 0; offset < list.length; offset += 100) {
      const batch = list.slice(offset, offset + 100),
        data = await this.call('ecs', 'describe-tasks', {
          cluster: this.context.cluster,
          tasks: batch,
        });
      if (data.failures !== undefined && array(data.failures).length !== 0) denied();
      const rows = array(data.tasks).map(record);
      if (rows.length !== batch.length || new Set(rows.map((t) => t.taskArn)).size !== batch.length)
        denied();
      for (const t of rows) {
        if (
          !batch.includes(this.taskArn(t.taskArn)) ||
          t.clusterArn !== this.arn(`cluster/${this.context.cluster}`)
        )
          denied();
        if (t.lastStatus !== 'STOPPED') {
          this.observedTasks.add(this.taskArn(t.taskArn));
          const service = RELEASE_SERVICES.find((n) => t.group === 'service:' + n);
          if (!service && t.taskArn !== allowedStandalone) {
            await this.observe();
            denied();
          }
          this.definition(t.taskDefinitionArn, service ?? 'migration');
        }
        tasks.push(t);
      }
    }
    await this.observe();
    return tasks;
  }
  private stopped(t: Record<string, unknown>): boolean {
    const containers = array(t.containers).map(record);
    return (
      t.lastStatus === 'STOPPED' &&
      containers.length > 0 &&
      containers.every((c) => c.lastStatus === 'STOPPED')
    );
  }
  private async held(intent: Intent, wait = false): Promise<void> {
    for (let i = 0; i < (wait ? 60 : 1); i++) {
      const targets = await this.targets();
      const matches = intent.services.every((s) => {
        const target = targets.find((t) => t.name === s.name);
        return target
          ? target.min === 0 &&
              target.max === s.capacity.max &&
              releaseHash(target.suspended) === releaseHash(HOLD)
          : !s.hadTarget;
      });
      if (matches) return;
      if (wait) await this.pause();
    }
    denied();
  }
  private async quiet(intent: Intent, allowedStandalone?: string): Promise<string[] | undefined> {
    await this.held(intent);
    const services = await this.services();
    if (
      services.some(
        (s) => s.taskDefinition !== intent.services.find((i) => i.name === s.name)!.taskDefinition,
      )
    )
      denied();
    const tasks = await this.tasks(intent.taskArns, allowedStandalone);
    if (
      services.some((s) => s.desired !== 0 || s.running !== 0 || s.pending !== 0) ||
      tasks.some((t) => t.taskArn !== allowedStandalone && !this.stopped(t))
    )
      return undefined;
    return tasks.map((t) => this.taskArn(t.taskArn)).sort();
  }
  async drain(recoveryFrom?: string): Promise<void> {
    await this.loadObservations();
    let stored = await this.read('intent');
    if (!stored) {
      const services = await this.services(),
        targets = await this.targets(),
        tasks = await this.tasks();
      let recovered: Intent | undefined;
      if (recoveryFrom) {
        if (
          !/^releases\/[a-f0-9]{40}\/[1-9][0-9]{0,19}\/[1-9][0-9]{0,8}\/intent\.json$/u.test(
            recoveryFrom,
          ) ||
          !(
            targets.some((t) => t.min === 0) ||
            targets.length < 4 ||
            services.every((s) => s.desired === 0 && s.running === 0 && s.pending === 0)
          )
        )
          denied();
        const raw = await this.custody.read(recoveryFrom);
        if (!raw) denied();
        const envelope = this.decode(raw);
        const prior = captureStagingContext(envelope.context as StagingReleaseContext);
        for (const key of ['accountId', 'region', 'cluster', 'bucket', 'secretArn'] as const)
          if (prior[key] !== this.context[key]) denied();
        recovered = this.parseIntent(envelope);
        // Preserve the pre-zero observed capacity, not a later maintenance zero.
        const heldRaw = await this.custody.read(
          recoveryFrom.replace(/intent\.json$/u, 'held.json'),
        );
        if (heldRaw) {
          const held = this.decode(heldRaw, prior),
            caps = record(held.payload);
          for (const s of recovered.services) s.capacity = capacity(caps[s.name]);
        }
      } else if (targets.some((t) => t.min < 2)) denied();
      if (!recovered && targets.length !== 0 && targets.length !== 4) denied();
      if (
        !recovered &&
        targets.length === 0 &&
        services.some((s) => s.desired !== 0 || s.running !== 0 || s.pending !== 0)
      )
        denied();
      if (!recovered && targets.length === 0)
        for (const service of services)
          await this.checkDefinition(service.taskDefinition, service.name, true);
      const intent: Intent = {
        services: services.map((s) => {
          const t = targets.find((t) => t.name === s.name),
            original = recovered?.services.find((i) => i.name === s.name)?.capacity;
          const min = t?.min ?? this.context.defaultMin,
            max = t?.max ?? this.context.defaultMax;
          if (s.desired > max && !original) denied();
          return {
            name: s.name,
            taskDefinition: s.taskDefinition,
            hadTarget: t !== undefined,
            capacity: original ?? {
              desired: Math.max(min, s.desired),
              min,
              max,
              suspended: t?.suspended ?? { ...RESUME },
            },
          };
        }),
        taskArns: tasks
          .filter((t) => !this.stopped(t))
          .map((t) => this.taskArn(t.taskArn))
          .sort(),
        recoveryFrom: recoveryFrom ?? null,
      };
      await this.save('intent', intent);
      stored = await this.read('intent');
    }
    if (!stored) denied();
    const intent = this.parseIntent(stored);
    if (intent.recoveryFrom !== (recoveryFrom ?? null)) denied();
    for (const target of await this.targets()) {
      const original = intent.services.find((s) => s.name === target.name)!;
      if (
        target.max !== original.capacity.max ||
        (!original.hadTarget &&
          (target.min !== 0 || releaseHash(target.suspended) !== releaseHash(HOLD)))
      )
        denied();
      await this.setTarget(target, true);
    }
    await this.held(intent, true);
    if (!(await this.read('held'))) {
      const services = await this.services(),
        caps = {} as Record<ReleaseService, ReleaseCapacity>;
      for (const s of intent.services) {
        const live = services.find((v) => v.name === s.name)!;
        if (live.taskDefinition !== s.taskDefinition) denied();
        caps[s.name] = { ...s.capacity, desired: Math.max(s.capacity.desired, live.desired) };
        capacity(caps[s.name]);
      }
      await this.save('held', caps);
    }
    for (const name of RELEASE_SERVICES)
      await this.call('ecs', 'update-service', {
        cluster: this.context.cluster,
        service: name,
        desiredCount: 0,
      });
    let observations = 0;
    for (let i = 0; i < 90; i++) {
      const stopped = await this.quiet(intent);
      observations = stopped ? observations + 1 : 0;
      if (observations === 2) {
        if (!(await this.read('drained'))) await this.save('drained', { taskArns: stopped });
        return;
      }
      await this.pause();
    }
    denied();
  }
  private async requireQuiet(allowedStandalone?: string): Promise<Intent> {
    await this.loadObservations();
    const intent = await this.intent();
    if (!(await this.read('drained')) || !(await this.quiet(intent, allowedStandalone))) denied();
    return intent;
  }
  private async checkDefinition(
    arn: string,
    name: ReleaseService | 'migration',
    bootstrap = false,
  ): Promise<void> {
    this.definition(arn, name);
    const data = await this.call('ecs', 'describe-task-definition', { taskDefinition: arn }),
      d = record(data.taskDefinition);
    if (
      d.taskDefinitionArn !== arn ||
      d.status !== 'ACTIVE' ||
      d.networkMode !== 'awsvpc' ||
      !array(d.requiresCompatibilities).includes('FARGATE')
    )
      denied();
    const rows = array(d.containerDefinitions).map(record),
      containers = rows.filter((v) => v.name === name);
    if (containers.length !== 1 || rows.length !== (name === 'migration' ? 1 : 2)) denied();
    const container = containers[0]!;
    const env = array(container.environment).map(record),
      secrets = array(container.secrets).map(record);
    const selectedImage = this.context.images[name === 'migration' ? 'api' : name];
    const image = bootstrap ? selectedImage.split('@')[0] + ':bootstrap' : selectedImage;
    if (
      container.image !== image ||
      container.essential !== true ||
      container.readonlyRootFilesystem !== true ||
      (container.entryPoint !== undefined && array(container.entryPoint).length !== 0) ||
      env.filter((e) => e.name === 'NAKH_RELEASE').length !== 1 ||
      !env.some(
        (e) =>
          e.name === 'NAKH_RELEASE' &&
          e.value === (bootstrap ? 'bootstrap' : this.context.sourceSha),
      ) ||
      env.filter((e) => e.name === 'NAKH_ENV').length !== 1 ||
      !env.some((e) => e.name === 'NAKH_ENV' && e.value === 'staging') ||
      env.filter((e) => e.name === 'NAKH_SERVICE_NAME').length !== 1 ||
      !env.some((e) => e.name === 'NAKH_SERVICE_NAME' && e.value === name) ||
      env.some((e) => e.name === 'NAKH_DATABASE_URL') ||
      secrets.filter((e) => e.name === 'NAKH_DATABASE_URL').length !== 1 ||
      secrets.filter(
        (e) =>
          e.name === 'NAKH_DATABASE_URL' &&
          e.valueFrom === this.context.secretArn + ':NAKH_DATABASE_URL::',
      ).length !== 1
    )
      denied();
    if (
      name === 'migration' &&
      JSON.stringify(container.command) !==
        JSON.stringify(['node', 'node_modules/@nakh/persistence-postgres/dist/cli/migrate.js'])
    )
      denied();
    if (
      name !== 'migration' &&
      ((container.command !== undefined && array(container.command).length !== 0) ||
        rows.filter((v) => v.name === 'otel-collector').length !== 1)
    )
      denied();
    if (container.privileged === true) denied();
  }
  async task(kind: TaskKind, taskDefinition: string): Promise<void> {
    const command = [
      'node',
      `node_modules/@nakh/persistence-postgres/dist/cli/${kind === 'migration' ? 'migrate' : 'compatibility'}.js`,
    ];
    const request = {
      cluster: this.context.cluster,
      taskDefinition,
      count: 1,
      launchType: 'FARGATE',
      platformVersion: '1.4.0',
      enableExecuteCommand: false,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: this.context.subnets,
          securityGroups: [this.context.securityGroup],
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: { containerOverrides: [{ name: 'migration', command }] },
    };
    const requestHash = releaseHash(request),
      token = releaseHash([this.context, kind, requestHash]);
    let started = await this.read(kind + '-started');
    let knownTask: string | undefined;
    if (started) {
      const previous = record(started.payload);
      if (previous.requestHash !== requestHash || previous.taskDefinition !== taskDefinition)
        denied();
      knownTask = this.taskArn(previous.taskArn);
    }
    await this.requireQuiet(knownTask);
    await this.checkDefinition(taskDefinition, 'migration');
    if (!started) {
      if ((await this.save(kind + '-prepared', { requestHash, taskDefinition })) !== 'created')
        denied();
      const data = await this.call('ecs', 'run-task', {
        ...request,
        clientToken: token,
        startedBy: 'nakh-' + token.slice(0, 24),
      });
      if (data.failures !== undefined && array(data.failures).length !== 0) denied();
      const tasks = array(data.tasks).map(record);
      if (
        tasks.length !== 1 ||
        tasks[0]?.taskDefinitionArn !== taskDefinition ||
        tasks[0]?.clusterArn !== this.arn(`cluster/${this.context.cluster}`)
      )
        denied();
      await this.save(kind + '-started', {
        requestHash,
        taskDefinition,
        taskArn: this.taskArn(tasks[0]?.taskArn),
      });
      started = await this.read(kind + '-started');
    }
    if (!started) denied();
    const start = record(started.payload);
    if (start.requestHash !== requestHash || start.taskDefinition !== taskDefinition) denied();
    const taskArn = this.taskArn(start.taskArn);
    for (let i = 0; i < 120; i++) {
      const data = await this.call('ecs', 'describe-tasks', {
        cluster: this.context.cluster,
        tasks: [taskArn],
      });
      const tasks = array(data.tasks).map(record),
        failures = data.failures === undefined ? [] : array(data.failures).map(record);
      if (failures.length !== 0) {
        if (
          tasks.length === 0 &&
          failures.length === 1 &&
          failures[0]?.arn === taskArn &&
          failures[0]?.reason === 'MISSING'
        ) {
          await this.pause();
          continue;
        }
        denied();
      }
      if (tasks.length !== 1) denied();
      const task = tasks[0]!;
      if (
        task.taskArn !== taskArn ||
        task.clusterArn !== this.arn(`cluster/${this.context.cluster}`) ||
        task.taskDefinitionArn !== taskDefinition
      )
        denied();
      if (task.lastStatus === 'STOPPED') {
        const containers = array(task.containers).map(record),
          container = containers[0];
        const overrides = array(record(task.overrides).containerOverrides).map(record);
        if (
          !this.stopped(task) ||
          task.stopCode !== 'EssentialContainerExited' ||
          containers.length !== 1 ||
          container?.name !== 'migration' ||
          container.exitCode !== 0 ||
          container.image !== this.context.images.api ||
          container.imageDigest !== this.context.images.api.split('@')[1] ||
          task.startedBy !== 'nakh-' + token.slice(0, 24) ||
          overrides.length !== 1 ||
          overrides[0]?.name !== 'migration' ||
          JSON.stringify(overrides[0]?.command) !== JSON.stringify(command) ||
          (overrides[0]?.environment !== undefined && array(overrides[0].environment).length !== 0)
        )
          denied();
        await this.save(kind + '-succeeded', { taskArn, taskDefinition, requestHash });
        return;
      }
      await this.pause();
    }
    denied();
  }
  async admission(): Promise<Record<ReleaseService, ReleaseCapacity>> {
    await this.requireQuiet();
    const proof = await this.read('compatibility-succeeded');
    if (
      !proof ||
      this.now() - Number(proof.observedAt) < 0 ||
      this.now() - Number(proof.observedAt) > 300000
    )
      denied();
    return this.capacities();
  }
  private async capacities(): Promise<Record<ReleaseService, ReleaseCapacity>> {
    const held = await this.read('held');
    if (!held) denied();
    const data = record(held.payload);
    if (Object.keys(data).sort().join(',') !== [...RELEASE_SERVICES].sort().join(',')) denied();
    return Object.fromEntries(RELEASE_SERVICES.map((n) => [n, capacity(data[n])])) as Record<
      ReleaseService,
      ReleaseCapacity
    >;
  }
  async healthy(restored = false): Promise<void> {
    await this.loadObservations();
    const intent = await this.intent(),
      caps = await this.capacities();
    if (!(await this.read('compatibility-succeeded'))) denied();
    for (let i = 0; i < 60; i++) {
      const targets = await this.targets();
      if (
        targets.length !== 4 ||
        targets.some(
          (t) =>
            t.max !== caps[t.name].max ||
            t.min !== (restored ? caps[t.name].min : 0) ||
            releaseHash(t.suspended) !== releaseHash(restored ? caps[t.name].suspended : HOLD),
        )
      ) {
        await this.pause();
        continue;
      }
      const services = await this.services();
      if (
        services.some(
          (s) =>
            s.desired < caps[s.name].min ||
            s.desired > caps[s.name].max ||
            (!restored && s.desired !== caps[s.name].desired) ||
            !s.stable ||
            s.running !== s.desired ||
            s.pending !== 0,
        )
      ) {
        await this.pause();
        continue;
      }
      for (const s of services) await this.checkDefinition(s.taskDefinition, s.name);
      const tasks = await this.tasks(intent.taskArns),
        active = tasks.filter((t) => !this.stopped(t));
      if (active.some((t) => !RELEASE_SERVICES.some((n) => t.group === 'service:' + n))) denied();
      for (const s of services) {
        const group = active.filter((t) => t.group === 'service:' + s.name);
        if (group.length !== s.desired) denied();
        for (const t of group) {
          const app = array(t.containers)
            .map(record)
            .find((v) => v.name === s.name);
          if (
            t.lastStatus !== 'RUNNING' ||
            t.taskDefinitionArn !== s.taskDefinition ||
            app?.lastStatus !== 'RUNNING' ||
            app.image !== this.context.images[s.name] ||
            app.imageDigest !== this.context.images[s.name].split('@')[1]
          )
            denied();
        }
      }
      if (!(await this.read(restored ? 'activated' : 'healthy')))
        await this.save(restored ? 'activated' : 'healthy', {
          services: services.map((s) => ({
            name: s.name,
            taskDefinition: s.taskDefinition,
            desired: s.desired,
          })),
          taskArns: active.map((t) => this.taskArn(t.taskArn)).sort(),
        });
      return;
    }
    denied();
  }
  async maintain(): Promise<void> {
    const intent = await this.intent();
    let failed = false;
    try {
      await this.loadObservations();
    } catch {
      failed = true;
    }
    try {
      const current = await this.services();
      for (const s of intent.services)
        s.taskDefinition = current.find((v) => v.name === s.name)!.taskDefinition;
    } catch {
      failed = true;
    }
    let targets: Target[] = [];
    try {
      targets = await this.targets();
    } catch {
      failed = true;
    }
    for (const target of targets)
      try {
        await this.setTarget(
          { ...target, max: intent.services.find((s) => s.name === target.name)!.capacity.max },
          true,
        );
      } catch {
        failed = true;
      }
    for (const name of RELEASE_SERVICES)
      try {
        await this.call('ecs', 'update-service', {
          cluster: this.context.cluster,
          service: name,
          desiredCount: 0,
        });
      } catch {
        failed = true;
      }
    if (failed) denied();
    for (let i = 0; i < 90; i++) {
      if (await this.quiet(intent)) {
        if (!(await this.read('maintenance')))
          await this.save('maintenance', { services: RELEASE_SERVICES });
        return;
      }
      await this.pause();
    }
    denied();
  }
}
