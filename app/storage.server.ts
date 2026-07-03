import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

export async function getPresignedDownloadUrl(filename: string): Promise<string | null> {
  if (!spacesEnabled) return null;
  try {
    return await getSignedUrl(
      s3(),
      new GetObjectCommand({ Bucket: BUCKET!, Key: `exports/${filename}` }),
      { expiresIn: 3600 },
    );
  } catch {
    return null;
  }
}

export async function getDownloadResponse(safeFilename: string): Promise<Response | null> {
  if (spacesEnabled) {
    try {
      const url = await getSignedUrl(
        s3(),
        new GetObjectCommand({ Bucket: BUCKET!, Key: `exports/${safeFilename}` }),
        { expiresIn: 3600 },
      );
      return new Response(null, { status: 302, headers: { Location: url } });
    } catch {
      return null;
    }
  }
  const filePath = path.join(UPLOADS_DIR, safeFilename);
  try {
    const buffer = await fs.readFile(filePath);
    const isCSV = safeFilename.endsWith(".csv");
    return new Response(buffer, {
      headers: {
        "Content-Type": isCSV ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
        "Content-Length": String(buffer.byteLength),
      },
    });
  } catch {
    return null;
  }
}
