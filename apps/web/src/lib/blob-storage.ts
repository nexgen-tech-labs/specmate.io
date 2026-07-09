import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

const CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER ?? 'sources';
const DOWNLOAD_URL_TTL_MS = 15 * 60 * 1000;

// Reuse the client across hot-reloads in dev, same pattern as prisma.ts.
const globalForBlob = globalThis as unknown as { blobServiceClient?: BlobServiceClient };

function getBlobServiceClient(): BlobServiceClient {
  if (globalForBlob.blobServiceClient) return globalForBlob.blobServiceClient;

  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING is not set.');
  }

  const client = BlobServiceClient.fromConnectionString(connectionString);
  if (process.env.NODE_ENV !== 'production') {
    globalForBlob.blobServiceClient = client;
  }
  return client;
}

function buildStorageKey(
  workspaceId: string,
  projectId: string,
  sourceId: string,
  fileName: string,
): string {
  return `${workspaceId}/${projectId}/${sourceId}/${fileName}`;
}

export async function uploadSourceFile(
  workspaceId: string,
  projectId: string,
  sourceId: string,
  fileName: string,
  file: Buffer,
  contentType: string,
): Promise<{ storageKey: string }> {
  const storageKey = buildStorageKey(workspaceId, projectId, sourceId, fileName);
  const containerClient = getBlobServiceClient().getContainerClient(CONTAINER_NAME);
  await containerClient.createIfNotExists();

  const blockBlobClient = containerClient.getBlockBlobClient(storageKey);
  await blockBlobClient.uploadData(file, {
    blobHTTPHeaders: { blobContentType: contentType },
  });

  return { storageKey };
}

export async function getDownloadUrl(storageKey: string): Promise<string> {
  const client = getBlobServiceClient();
  const containerClient = client.getContainerClient(CONTAINER_NAME);
  const blobClient = containerClient.getBlobClient(storageKey);

  const credential = client.credential;
  if (!(credential instanceof StorageSharedKeyCredential)) {
    throw new Error('SAS URL generation requires a shared-key credential.');
  }

  const sas = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER_NAME,
      blobName: storageKey,
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(Date.now() + DOWNLOAD_URL_TTL_MS),
    },
    credential,
  ).toString();

  return `${blobClient.url}?${sas}`;
}

export async function deleteSourceFile(storageKey: string): Promise<void> {
  const containerClient = getBlobServiceClient().getContainerClient(CONTAINER_NAME);
  await containerClient.getBlockBlobClient(storageKey).deleteIfExists();
}
