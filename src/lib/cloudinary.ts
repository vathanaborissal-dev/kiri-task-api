import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';
import { badRequest } from './errors.js';
import { logger } from './logger.js';

if (env.cloudinaryEnabled) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
} else {
  logger.warn('Cloudinary is not configured — attachment uploads will be rejected.');
}

export type UploadedFile = {
  url: string;
  publicId: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  resourceType: string;
  filename: string;
};

export const uploadBuffer = async (
  buffer: Buffer,
  options: { folder: string; filename: string; mimeType: string },
): Promise<UploadedFile> => {
  if (!env.cloudinaryEnabled) throw badRequest('File storage is not configured on this server');

  const resourceType = options.mimeType.startsWith('image/') ? 'image' : 'auto';

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${env.CLOUDINARY_FOLDER}/${options.folder}`,
        resource_type: resourceType,
        use_filename: true,
        unique_filename: true,
        overwrite: false,
      },
      (error, uploadResult) => {
        if (error || !uploadResult) return reject(error ?? new Error('Upload failed'));
        resolve(uploadResult as unknown as Record<string, unknown>);
      },
    );
    stream.end(buffer);
  });

  return {
    url: String(result.secure_url),
    publicId: String(result.public_id),
    mimeType: options.mimeType,
    bytes: Number(result.bytes ?? buffer.byteLength),
    width: result.width ? Number(result.width) : undefined,
    height: result.height ? Number(result.height) : undefined,
    resourceType: String(result.resource_type ?? resourceType),
    filename: options.filename,
  };
};

export const uploadRemoteUrl = async (
  url: string,
  options: { folder: string; filename: string },
): Promise<UploadedFile> => {
  if (!env.cloudinaryEnabled) throw badRequest('File storage is not configured on this server');
  const result = await cloudinary.uploader.upload(url, {
    folder: `${env.CLOUDINARY_FOLDER}/${options.folder}`,
    resource_type: 'auto',
  });
  return {
    url: result.secure_url,
    publicId: result.public_id,
    mimeType: `${result.resource_type}/${result.format ?? 'bin'}`,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
    resourceType: result.resource_type,
    filename: options.filename,
  };
};

export const destroyUpload = async (publicId: string, resourceType = 'image') => {
  if (!env.cloudinaryEnabled) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (error) {
    logger.warn({ error, publicId }, 'Failed to delete Cloudinary asset');
  }
};
