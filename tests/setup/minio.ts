import { AwsClient } from 'aws4fetch';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const ACCESS_KEY = 'auditsink';
const SECRET_KEY = 'auditsinksecret';
const BUCKET = 'audit';
const REGION = 'us-east-1';

let container: StartedTestContainer | undefined;

/**
 * The bucket is created **with object lock**, mirroring `mc mb --with-lock`, so
 * the integration tests exercise the same WORM behaviour the spike verified
 * (specs/2026-09-04-audit-sink-spike.md) rather than a plain bucket that would
 * pass the retry test for the wrong reason.
 *
 * Created over the S3 API with aws4fetch — already a dependency — instead of a
 * second `mc` image, which would double the pull for two requests.
 */
async function createLockedBucket(endpoint: string): Promise<void> {
	const client = new AwsClient({
		accessKeyId: ACCESS_KEY,
		secretAccessKey: SECRET_KEY,
		service: 's3',
		region: REGION
	});

	const created = await client.fetch(`${endpoint}/${BUCKET}`, {
		method: 'PUT',
		headers: { 'x-amz-bucket-object-lock-enabled': 'true' }
	});
	if (!created.ok) {
		throw new Error(`MinIO: creating the locked bucket failed with ${created.status}`);
	}

	// One day, so a failed teardown cannot leave a developer's Docker volume
	// holding undeletable objects for a meaningful length of time.
	const retention = await client.fetch(`${endpoint}/${BUCKET}?object-lock=`, {
		method: 'PUT',
		headers: { 'content-type': 'application/xml' },
		body:
			'<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled>' +
			'<Rule><DefaultRetention><Mode>GOVERNANCE</Mode><Days>1</Days></DefaultRetention></Rule>' +
			'</ObjectLockConfiguration>'
	});
	if (!retention.ok) {
		throw new Error(`MinIO: setting default retention failed with ${retention.status}`);
	}
}

export async function setup() {
	container = await new GenericContainer('quay.io/minio/minio:latest')
		.withCommand(['server', '/data'])
		.withEnvironment({ MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY })
		.withExposedPorts(9000)
		.withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
		.start();

	const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
	await createLockedBucket(endpoint);

	process.env.TEST_S3_ENDPOINT = endpoint;
	process.env.TEST_S3_BUCKET = BUCKET;
	process.env.TEST_S3_REGION = REGION;
	process.env.TEST_S3_ACCESS_KEY = ACCESS_KEY;
	process.env.TEST_S3_SECRET_KEY = SECRET_KEY;
}

export async function teardown() {
	await container?.stop();
}
