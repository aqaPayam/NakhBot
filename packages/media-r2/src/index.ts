import type { MediaStorePort } from '@nakh/application';

export type R2Location = Readonly<{
  endpoint: string;
  bucket: string;
}>;

export class UnconfiguredR2MediaStore implements MediaStorePort {
  public put(): Promise<void> {
    return Promise.reject(new Error('The production R2 media adapter is configured in M2.'));
  }

  public delete(): Promise<void> {
    return Promise.reject(new Error('The production R2 media adapter is configured in M2.'));
  }

  public exists(): Promise<boolean> {
    return Promise.reject(new Error('The production R2 media adapter is configured in M2.'));
  }
}
