/**
 * The AWS provider (#301) against recording fakes of the SDK clients: which
 * calls, in which order, with which inputs — and what survives a failure.
 */
import { AwsObjectStorageProvider, USER_POLICY_NAME, type Sender } from './aws-provider';

type Call = { client: string; command: string; input: Record<string, any> };

function fakeClients(overrides: Record<string, (input: any) => any> = {}) {
  const calls: Call[] = [];
  const make = (client: string): Sender => ({
    send: async (command: any) => {
      const name = command.constructor.name as string;
      calls.push({ client, command: name, input: command.input });
      const handler = overrides[name];
      return handler ? handler(command.input) : {};
    },
  });
  return { calls, clients: { s3: make('s3'), iam: make('iam'), sts: make('sts') } };
}

const gone = (name: string) => () => {
  throw Object.assign(new Error(name), { name });
};

const keyOk = () => ({ AccessKey: { AccessKeyId: 'AKIAAPP', SecretAccessKey: 'app-secret' } });

describe('AwsObjectStorageProvider.provision', () => {
  it('creates a private bucket, then a user scoped to it, then its key', async () => {
    const { calls, clients } = fakeClients({ CreateAccessKeyCommand: keyOk });
    const provider = new AwsObjectStorageProvider('eu-central-1', clients);

    const key = await provider.provision({ appName: 'site', bucket: 'p-site-1', userName: 'drop-p-site' });

    expect(key).toEqual({ accessKeyId: 'AKIAAPP', secretAccessKey: 'app-secret' });
    expect(calls.map((c) => c.command)).toEqual([
      'CreateBucketCommand',
      'PutPublicAccessBlockCommand',
      'CreateUserCommand',
      'PutUserPolicyCommand',
      'CreateAccessKeyCommand',
    ]);
    expect(calls[0].input).toEqual(
      expect.objectContaining({
        Bucket: 'p-site-1',
        CreateBucketConfiguration: { LocationConstraint: 'eu-central-1' },
        ObjectOwnership: 'BucketOwnerEnforced',
      })
    );
    expect(Object.values(calls[1].input.PublicAccessBlockConfiguration).every(Boolean)).toBe(true);
    expect(calls[2].input).toEqual(expect.objectContaining({ UserName: 'drop-p-site', Path: '/drop/' }));
    const policy = JSON.parse(calls[3].input.PolicyDocument);
    expect(JSON.stringify(policy)).toContain('arn:aws:s3:::p-site-1');
    expect(calls[3].input.PolicyName).toBe(USER_POLICY_NAME);
  });

  it('sends no location constraint in us-east-1, which rejects one', async () => {
    const { calls, clients } = fakeClients({ CreateAccessKeyCommand: keyOk });
    await new AwsObjectStorageProvider('us-east-1', clients).provision({ appName: 'a', bucket: 'b', userName: 'u' });
    expect(calls[0].input.CreateBucketConfiguration).toBeUndefined();
  });

  it('removes the user and the bucket it created when a later step fails', async () => {
    const { calls, clients } = fakeClients({
      CreateAccessKeyCommand: gone('LimitExceeded'),
      ListAccessKeysCommand: () => ({ AccessKeyMetadata: [] }),
      ListObjectVersionsCommand: () => ({}),
    });

    await expect(
      new AwsObjectStorageProvider('eu-central-1', clients).provision({ appName: 'a', bucket: 'b', userName: 'u' })
    ).rejects.toMatchObject({ name: 'LimitExceeded' });

    const names = calls.map((c) => c.command);
    expect(names).toEqual(expect.arrayContaining(['DeleteUserCommand', 'DeleteBucketCommand']));
    expect(names.indexOf('DeleteUserCommand')).toBeGreaterThan(names.indexOf('CreateAccessKeyCommand'));
  });

  it('removes only the bucket when creating the user fails', async () => {
    const { calls, clients } = fakeClients({
      CreateUserCommand: gone('EntityAlreadyExists'),
      ListObjectVersionsCommand: () => ({}),
    });

    await expect(
      new AwsObjectStorageProvider('eu-central-1', clients).provision({ appName: 'a', bucket: 'b', userName: 'u' })
    ).rejects.toMatchObject({ name: 'EntityAlreadyExists' });

    const names = calls.map((c) => c.command);
    expect(names).toContain('DeleteBucketCommand');
    expect(names).not.toContain('DeleteUserCommand');
  });
});

describe('AwsObjectStorageProvider.deprovision', () => {
  it('revokes first, then empties every version and upload, then deletes the bucket', async () => {
    let page = 0;
    const { calls, clients } = fakeClients({
      ListAccessKeysCommand: () => ({ AccessKeyMetadata: [{ AccessKeyId: 'K1' }, { AccessKeyId: 'K2' }] }),
      ListObjectVersionsCommand: () =>
        ++page === 1
          ? {
              Versions: Array.from({ length: 1200 }, (_, i) => ({ Key: `k${i}`, VersionId: 'v' })),
              IsTruncated: true,
              NextKeyMarker: 'k1199',
              NextVersionIdMarker: 'v',
            }
          : { DeleteMarkers: [{ Key: 'gone', VersionId: 'dm' }], IsTruncated: false },
      ListMultipartUploadsCommand: () => ({ Uploads: [{ Key: 'big', UploadId: 'u1' }] }),
    });

    const result = await new AwsObjectStorageProvider('eu-central-1', clients).deprovision({ bucket: 'b', userName: 'u' });

    expect(result).toEqual({ objectsDeleted: 1201, bucketDeleted: true, userDeleted: true });
    const names = calls.map((c) => c.command);
    expect(names.filter((n) => n === 'DeleteAccessKeyCommand')).toHaveLength(2);
    expect(names.indexOf('DeleteUserCommand')).toBeLessThan(names.indexOf('ListObjectVersionsCommand'));
    const batches = calls.filter((c) => c.command === 'DeleteObjectsCommand').map((c) => c.input.Delete.Objects.length);
    expect(batches).toEqual([1000, 200, 1]);
    expect(calls.find((c) => c.command === 'ListObjectVersionsCommand' && c.input.KeyMarker === 'k1199')).toBeDefined();
    expect(names).toContain('AbortMultipartUploadCommand');
    expect(names[names.length - 1]).toBe('DeleteBucketCommand');
  });

  it('treats resources that are already gone as done, so a retry finishes', async () => {
    const { clients } = fakeClients({
      ListAccessKeysCommand: gone('NoSuchEntity'),
      ListObjectVersionsCommand: gone('NoSuchBucket'),
    });

    await expect(
      new AwsObjectStorageProvider('eu-central-1', clients).deprovision({ bucket: 'b', userName: 'u' })
    ).resolves.toEqual({ objectsDeleted: 0, bucketDeleted: false, userDeleted: false });
  });

  it('surfaces any other failure', async () => {
    const { clients } = fakeClients({ ListAccessKeysCommand: gone('AccessDenied') });
    await expect(
      new AwsObjectStorageProvider('eu-central-1', clients).deprovision({ bucket: 'b', userName: 'u' })
    ).rejects.toMatchObject({ name: 'AccessDenied' });
  });
});

describe('AwsObjectStorageProvider.whoAmI', () => {
  it('reports the account of the admin credential', async () => {
    const { clients } = fakeClients({ GetCallerIdentityCommand: () => ({ Account: '123456789012' }) });
    await expect(new AwsObjectStorageProvider('eu-central-1', clients).whoAmI()).resolves.toEqual({ account: '123456789012' });
  });
});
