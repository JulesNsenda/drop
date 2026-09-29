/** Bucket/user naming and the per-bucket policy (#301). */
import { bucketNameFor, iamUserNameFor, bucketOnlyPolicy, BUCKET_PREFIX_RE } from './naming';

const S3_BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

describe('bucketNameFor', () => {
  it.each(['site', 'My_App', 'a', 'x'.repeat(64), '__weird__', 'Upper-CASE_mix-9'])(
    'always yields a valid, dot-free S3 bucket name for %j',
    (app) => {
      const name = bucketNameFor('dropkit', app, 'a1b2c3d4');
      expect(name).toMatch(S3_BUCKET_RE);
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name.startsWith('dropkit-')).toBe(true);
      expect(name.endsWith('-a1b2c3d4')).toBe(true);
    }
  );

  it('is random per call, so a recreated app never reuses a bucket name', () => {
    expect(bucketNameFor('p', 'site')).not.toBe(bucketNameFor('p', 'site'));
  });
});

describe('iamUserNameFor', () => {
  it('is deterministic, IAM-valid and within 64 characters', () => {
    const name = iamUserNameFor('dropkit', 'My_App');
    expect(name).toBe('drop-dropkit-My_App');
    expect(iamUserNameFor('p', 'x'.repeat(64)).length).toBeLessThanOrEqual(64);
    expect(iamUserNameFor('p', 'a.b@c')).toMatch(/^[A-Za-z0-9+=,.@_-]+$/);
  });
});

describe('BUCKET_PREFIX_RE', () => {
  it('accepts short lowercase prefixes and rejects everything else', () => {
    for (const ok of ['a', 'dropkit', 'my-drop-1']) expect(BUCKET_PREFIX_RE.test(ok)).toBe(true);
    for (const bad of ['', '-a', 'a-', 'A', 'a_b', 'a.b', 'x'.repeat(21)]) expect(BUCKET_PREFIX_RE.test(bad)).toBe(false);
  });
});

describe('bucketOnlyPolicy', () => {
  it('grants object access on exactly one bucket, with no wildcard bucket and no ACL or policy actions', () => {
    const policy = JSON.parse(bucketOnlyPolicy('p-site-1'));
    const resources = policy.Statement.map((s: { Resource: string }) => s.Resource);
    expect(resources).toEqual(['arn:aws:s3:::p-site-1', 'arn:aws:s3:::p-site-1/*']);
    const actions: string[] = policy.Statement.flatMap((s: { Action: string[] }) => s.Action);
    expect(actions.every((a) => a.startsWith('s3:'))).toBe(true);
    expect(actions.some((a) => a.includes('*') || /Acl|Policy/.test(a))).toBe(false);
    expect(policy.Statement.every((s: { Effect: string }) => s.Effect === 'Allow')).toBe(true);
  });
});
