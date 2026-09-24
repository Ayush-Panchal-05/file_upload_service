const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { s3 } = require('../config/aws');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const router = express.Router();

const s3MetaRoot = path.join(__dirname, '../../uploads/s3');
if (!fs.existsSync(s3MetaRoot)) {
  fs.mkdirSync(s3MetaRoot, { recursive: true });
}

function metaPath(uploadId) {
  return path.join(s3MetaRoot, uploadId, 'metadata.json');
}

async function readMeta(uploadId) {
  try {
    const data = await fs.promises.readFile(metaPath(uploadId), 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

async function writeMeta(uploadId, meta) {
  const dir = path.dirname(metaPath(uploadId));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(metaPath(uploadId), JSON.stringify(meta, null, 2));
}

/** POST /uploads/initiate **/
router.post('/uploads/initiate', async (req, res) => {
  try {
    const { fileName, fileSize, partSize = 10 * 1024 * 1024 } = req.body;
    if (!fileName || !fileSize) {
      return res.status(400).json({ error: 'fileName and fileSize required' });
    }
    const uploadId = uuidv4();
    const bucket = process.env.AWS_S3_BUCKET;
    const key = `${uploadId}/${path.basename(fileName)}`;

    const createCmd = new CreateMultipartUploadCommand({ Bucket: bucket, Key: key });
    const { UploadId: s3UploadId } = await s3.send(createCmd);

    const meta = {
      uploadId,
      s3UploadId,
      bucket,
      key,
      fileName,
      fileSize,
      partSize,
      parts: {},
      createdAt: new Date().toISOString(),
      completed: false
    };
    await writeMeta(uploadId, meta);

    const totalParts = Math.ceil(fileSize / partSize);
    res.status(201).json({ uploadId, s3UploadId, partSize, totalParts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to initiate upload' });
  }
});

/** POST /uploads/:id/presigned-url **/
router.post('/uploads/:id/presigned-url', async (req, res) => {
  try {
    const { id } = req.params;
    const { partNumber } = req.body;
    if (!partNumber) {
      return res.status(400).json({ error: 'partNumber required' });
    }
    const meta = await readMeta(id);
    if (!meta) return res.status(404).json({ error: 'Upload not found' });

    const cmd = new UploadPartCommand({
      Bucket: meta.bucket,
      Key: meta.key,
      UploadId: meta.s3UploadId,
      PartNumber: partNumber
    });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 900 });
    res.json({ url, partNumber });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

router.post('/uploads/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { parts } = req.body;
    if (!Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ error: 'parts array required' });
    }
    const meta = await readMeta(id);
    if (!meta) return res.status(404).json({ error: 'Upload not found' });
    if (meta.completed) return res.json({ ...meta, message: 'Already completed' });

    const sortedParts = parts
      .map(p => ({ PartNumber: Number(p.PartNumber), ETag: p.ETag }))
      .sort((a, b) => a.PartNumber - b.PartNumber);

    const completeCmd = new CompleteMultipartUploadCommand({
      Bucket: meta.bucket,
      Key: meta.key,
      UploadId: meta.s3UploadId,
      MultipartUpload: { Parts: sortedParts }
    });
    await s3.send(completeCmd);

    meta.completed = true;
    meta.completedAt = new Date().toISOString();
    await writeMeta(id, meta);
    res.json({ message: 'Upload completed', uploadId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete upload' });
  }
});

/** GET /uploads/:id/status **/
router.get('/uploads/:id/status', async (req, res) => {
  try {
    const meta = await readMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Upload not found' });
    const uploadedParts = Object.keys(meta.parts).map(p => Number(p));
    const progress = Math.min(
      100,
      Math.round((uploadedParts.length * meta.partSize) / meta.fileSize * 100)
    );
    res.json({
      uploadId: meta.uploadId,
      fileName: meta.fileName,
      completed: meta.completed,
      uploadedParts,
      progress,
      createdAt: meta.createdAt,
      completedAt: meta.completedAt
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/** GET /uploads/:id/download-url **/
router.get('/uploads/:id/download-url', async (req, res) => {
  try {
    const meta = await readMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Upload not found' });
    if (!meta.completed) return res.status(400).json({ error: 'Upload not completed yet' });
    const cmd = new GetObjectCommand({ Bucket: meta.bucket, Key: meta.key });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

/** DELETE /uploads/:id **/
router.delete('/uploads/:id', async (req, res) => {
  try {
    const meta = await readMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Upload not found' });

    if (!meta.completed) {
      const abortCmd = new AbortMultipartUploadCommand({
        Bucket: meta.bucket,
        Key: meta.key,
        UploadId: meta.s3UploadId
      });
      await s3.send(abortCmd);
    }
    try {
      const delCmd = new DeleteObjectCommand({ Bucket: meta.bucket, Key: meta.key });
      await s3.send(delCmd);
    } catch (_) { }
    await fs.promises.rm(path.join(s3MetaRoot, req.params.id), { recursive: true, force: true });
    res.json({ message: 'Upload aborted and cleaned up' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete upload' });
  }
});

module.exports = router;
