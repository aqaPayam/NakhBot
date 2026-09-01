import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { CreateSampleEffectCommandSchema } from './index.js';

const addFormats = formatsModule.default as unknown as (
  ajv: InstanceType<typeof Ajv>,
) => InstanceType<typeof Ajv>;

describe('command contracts', () => {
  it('rejects unversioned or additional input', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(CreateSampleEffectCommandSchema);

    expect(validate({ commandType: 'platform.create-sample-effect', unknown: true })).toBe(false);
  });
});
