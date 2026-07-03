import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import path from "path";
import fs from "fs/promises";

export const UPLOADS_DIR = path.join(process.cwd(), "uploads");

const ENDPOINT = process.env.DO_SPACES_ENDPOINT;
const BUCKET = process.env.DO_SPACES_BUCKET;
const KEY = process.env.DO_SPACES_KEY;
const SECRET = process.env.DO_SPACES_SECRET;
const REGION = process.env.DO_SPACES_REGION ?? "nyc3";

export const spacesEnabled = !!(ENDPOINT && BUCKET && KEY && SECRET);

let _client: S3Client | null = null;
function s3(): S3Client {
  if (!_client) {
    _client = new S3Client({
      endpoint: ENDPOINT!,
      region: REGION,
      credentials: { accessKeyId: KEY!, secretAccessKey: SECRET! },
      // DO Spaces doesn't support the CRC32 checksums AWS SDK v3 sends by default
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _client;
}

export async function saveFile(buffer: Buffer, filename: string, contentType: string): Promise<string> {
  if (spacesEnabled) {
    await s3().send(new PutObjectCommand({
      Bucket: BUCKET!,
      Key: `exports/${filename}`,
      Body: buffer,
      ContentType: contentType,
    }));
  } else {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    await fs.writeFile(path.join(UPLOADS_DIR, filename), buffer);
  }
  return `/api/download/${filename}`;
}

export async function deleteFile(filename: string): Promise<void> {
  if (spacesEnabled) {
    await s3().send(new DeleteObjectCommand({ Bucket: BUCKET!, Key: `exports/${filename}` })).catch(() => {});
  } else {
    await fs.unlink(path.join(UPLOADS_DIR, filename)).catch(() => {});
  }
}

export async function getDownloadResponse(safeFilename: string): Promise<Response | null> {
  const isCSV = safeFilename.endsWith(".csv");
  const contentType = isCSV
    ? "text/csv"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  let bytes: Uint8Array;
  if (spacesEnabled) {
    // Stream the object through the app's own origin (rather than redirecting to a
    // cross-origin presigned URL) so the download works inside Shopify's iframe.
    try {
      const obj = await s3().send(
        new GetObjectCommand({ Bucket: BUCKET!, Key: `exports/${safeFilename}` }),
      );
      bytes = await obj.Body!.transformToByteArray();
    } catch {
      return null;
    }
  } else {
    try {
      bytes = new Uint8Array(await fs.readFile(path.join(UPLOADS_DIR, safeFilename)));
    } catch {
      return null;
    }
  }

  return new Response(new Blob([bytes as unknown as BlobPart]), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Content-Length": String(bytes.byteLength),
    },
  });
}
