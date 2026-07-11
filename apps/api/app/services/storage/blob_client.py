"""Read access to the Azure Blob Storage container that apps/web writes uploaded
Source files into (see apps/web/src/lib/blob-storage.ts for the write side and the
storageKey path convention: workspaceId/projectId/sourceId/filename)."""

from __future__ import annotations

from azure.storage.blob.aio import BlobServiceClient

from app.core.config import settings


class BlobDownloadError(Exception):
    """Raised when a Source's blob can't be fetched from storage."""


async def download_blob(storage_key: str) -> bytes:
    if not settings.azure_storage_connection_string:
        raise BlobDownloadError("AZURE_STORAGE_CONNECTION_STRING is not configured.")

    try:
        async with BlobServiceClient.from_connection_string(
            settings.azure_storage_connection_string
        ) as service_client:
            container_client = service_client.get_container_client(
                settings.azure_storage_container
            )
            blob_client = container_client.get_blob_client(storage_key)
            downloader = await blob_client.download_blob()
            return await downloader.readall()
    except Exception as exc:  # noqa: BLE001 -- surfaced as a clear, typed error to the caller
        raise BlobDownloadError(f"Could not download blob '{storage_key}': {exc}") from exc
