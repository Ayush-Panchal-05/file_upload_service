const express = require('express');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { v4: uuidv4 } = require('uuid');
const { pool, uploadDir } = require('../config/db');
const router = express.Router();
const uploadRoot = path.join(__dirname, '../../uploads/resumable');
const defaultChunkSize = 10 * 1024 * 1024;

fs.mkdirSync(uploadRoot, { recursive: true });

function uploadPath(uploadId) {
    return path.join(uploadRoot, uploadId);
}

function metadataPath(uploadId) {
    return path.join(uploadPath(uploadId), 'metadata.json');
}

function chunkPath(uploadId, chunkIndex) {
    return path.join(uploadPath(uploadId), 'chunks', `${chunkIndex}.part`);
}

function parsePositiveInteger(value, field) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) {
        const error = new Error(`${field} must be a positive integer`);
        error.statusCode = 400;
        throw error;
    }
    return number;
}

async function readMetadata(uploadId) {
    try {
        return JSON.parse(await fs.promises.readFile(metadataPath(uploadId), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

async function writeMetadata(uploadId, metadata) {
    await fs.promises.writeFile(metadataPath(uploadId), JSON.stringify(metadata, null, 2));
}

function sendError(res, error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 500) {
        console.error(error);
    }
    return res.status(statusCode).json({ error: error.message || 'Upload failed' });
}

router.post('/uploads/initiate', async (req, res) => {
    try {
        const { fileName, fileSize, chunkSize = defaultChunkSize } = req.body || {};
        if (typeof fileName !== 'string' || fileName.trim() === '') {
            return res.status(400).json({ error: 'fileName is required' });
        }

        const size = parsePositiveInteger(fileSize, 'fileSize');
        const selectedChunkSize = parsePositiveInteger(chunkSize, 'chunkSize');
        const totalChunks = Math.ceil(size / selectedChunkSize);
        const uploadId = uuidv4();
        const metadata = {
            uploadId,
            fileName: path.basename(fileName),
            fileSize: size,
            chunkSize: selectedChunkSize,
            totalChunks,
            createdAt: new Date().toISOString(),
            completed: false
        };

        await fs.promises.mkdir(path.join(uploadPath(uploadId), 'chunks'), { recursive: true });
        await writeMetadata(uploadId, metadata);
        res.status(201).json({ uploadId, fileName: metadata.fileName, fileSize: size, chunkSize: selectedChunkSize, totalChunks });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/uploads/:uploadId/chunk', async (req, res) => {
    const { uploadId } = req.params;
    try {
        const metadata = await readMetadata(uploadId);
        if (!metadata) {
            return res.status(404).json({ error: 'Upload not found' });
        }
        if (metadata.completed) {
            return res.status(409).json({ error: 'Upload is already complete' });
        }

        const chunkIndexValue = Number(req.get('x-chunk-index'));
        if (!Number.isSafeInteger(chunkIndexValue) || chunkIndexValue < 0) {
            return res.status(400).json({ error: 'x-chunk-index must be a zero-based integer' });
        }
        const chunkIndex = chunkIndexValue;
        if (chunkIndex >= metadata.totalChunks) {
            return res.status(400).json({ error: 'Chunk index is outside the upload range' });
        }

        const expectedSize = chunkIndex === metadata.totalChunks - 1
            ? metadata.fileSize - (metadata.chunkSize * chunkIndex)
            : metadata.chunkSize;
        const contentLengthHeader = req.get('content-length');
        const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
        if (contentLength !== undefined && Number.isSafeInteger(contentLength) && contentLength !== expectedSize) {
            return res.status(400).json({ error: `Chunk must be ${expectedSize} bytes` });
        }

        const destination = chunkPath(uploadId, chunkIndex);
        try {
            const existing = await fs.promises.stat(destination);
            if (existing.size === expectedSize) {
                return res.json({ uploadId, chunkIndex, duplicate: true, message: 'Chunk already uploaded' });
            }
            await fs.promises.unlink(destination);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        const temporaryPath = `${destination}.${uuidv4()}.tmp`;
        try {
            await pipeline(req, fs.createWriteStream(temporaryPath, { flags: 'wx' }));
            const savedChunk = await fs.promises.stat(temporaryPath);
            if (savedChunk.size !== expectedSize) {
                const error = new Error(`Chunk must be ${expectedSize} bytes`);
                error.statusCode = 400;
                throw error;
            }
            try {
                await fs.promises.rename(temporaryPath, destination);
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                const existing = await fs.promises.stat(destination);
                if (existing.size !== expectedSize) throw error;
                return res.json({ uploadId, chunkIndex, duplicate: true, message: 'Chunk already uploaded' });
            }
        } finally {

            try {
                await fs.promises.rm(temporaryPath, { force: true });
            } catch (e) {
            }
        }

        res.status(201).json({ uploadId, chunkIndex, uploaded: true });
    } catch (error) {
        sendError(res, error);
    }
});

router.get('/uploads/:uploadId/status', async (req, res) => {
    try {
        const metadata = await readMetadata(req.params.uploadId);
        if (!metadata) return res.status(404).json({ error: 'Upload not found' });

        const uploadedChunks = [];
        let uploadedBytes = 0;
        for (let chunkIndex = 0; chunkIndex < metadata.totalChunks; chunkIndex += 1) {
            try {
                const chunk = await fs.promises.stat(chunkPath(req.params.uploadId, chunkIndex));
                uploadedChunks.push({ chunkIndex, size: chunk.size });
                uploadedBytes += chunk.size;
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }

        res.json({
            ...metadata,
            uploadedChunks,
            uploadedChunkIndexes: uploadedChunks.map((chunk) => chunk.chunkIndex),
            missingChunks: Array.from({ length: metadata.totalChunks }, (_, index) => index)
                .filter((index) => !uploadedChunks.some((chunk) => chunk.chunkIndex === index)),
            uploadedBytes,
            progress: Math.min(100, Math.round((uploadedBytes / metadata.fileSize) * 100))
        });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/uploads/:uploadId/complete', async (req, res) => {
    try {
        const metadata = await readMetadata(req.params.uploadId);
        if (!metadata) return res.status(404).json({ error: 'Upload not found' });
        if (metadata.completed) return res.json({ ...metadata, message: 'Upload already complete' });

        const finalPath = path.join(uploadPath(req.params.uploadId), metadata.fileName);
        const output = fs.createWriteStream(finalPath, { flags: 'wx' });
        try {
            for (let chunkIndex = 0; chunkIndex < metadata.totalChunks; chunkIndex += 1) {
                const source = chunkPath(req.params.uploadId, chunkIndex);
                const expectedSize = chunkIndex === metadata.totalChunks - 1
                    ? metadata.fileSize - (metadata.chunkSize * chunkIndex)
                    : metadata.chunkSize;
                try {
                    const chunkStat = await fs.promises.stat(source);
                    if (chunkStat.size !== expectedSize) {
                        const err = new Error(`Chunk ${chunkIndex} has an invalid size`);
                        err.statusCode = 409;
                        throw err;
                    }
                } catch (err) {
                    if (err.statusCode === 409) throw err;
                    const missingErr = new Error(`Chunk ${chunkIndex} is missing`);
                    missingErr.statusCode = 409;
                    throw missingErr;
                }
                await pipeline(fs.createReadStream(source), output, { end: false });
            }
            output.end();
            await new Promise((resolve, reject) => {
                output.once('finish', resolve);
                output.once('error', reject);
            });
            try {
                await fs.promises.rm(path.join(uploadPath(req.params.uploadId), 'chunks'), { recursive: true, force: true });
            } catch (cleanupErr) {
                console.error('Chunk cleanup error:', cleanupErr);
            }
        } catch (error) {
            output.destroy();
            await fs.promises.rm(finalPath, { force: true });
            throw error;
        }

        const completedMetadata = { ...metadata, completed: true, completedAt: new Date().toISOString(), path: finalPath };
        await writeMetadata(req.params.uploadId, completedMetadata);
        res.json({ ...completedMetadata, message: 'Upload complete' });
    } catch (error) {
        sendError(res, error);
    }
});

router.delete('/uploads/:uploadId', async (req, res) => {
    try {
        if (!await readMetadata(req.params.uploadId)) {
            return res.status(404).json({ error: 'Upload not found' });
        }
        await fs.promises.rm(uploadPath(req.params.uploadId), { recursive: true, force: true });
        res.json({ message: 'Upload deleted' });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/files/upload', (req, res) => {

    const fileId = uuidv4();
    let fileSize = 0;
    const originalName = req.headers['x-filename'] || `${fileId}`; 
    const safeName = path.basename(originalName);
    const savePath = path.join(uploadDir, `${fileId}_${safeName}`);
    const fileStream = fs.createWriteStream(savePath);

    req.on('data', (chunk) => {
        fileSize += chunk.length;
        if (fileSize > 5 * 1024 * 1024 * 1024) {
            req.unpipe();
            fileStream.destroy();
            fs.unlinkSync(savePath);
            return res.status(413).json({ error: 'File too large' });
        }
    });

    req.pipe(fileStream);

    fileStream.on('finish', async () => {
        const mime = req.headers['content-type'] || 'application/octet-stream';
        const insertSQL = 'INSERT INTO files (id, filename, mime, size, path) VALUES (?, ?, ?, ?, ?)';
        await pool.execute(insertSQL, [fileId, safeName, mime, fileSize, savePath]);
        res.json({ id: fileId, filename: safeName, size: fileSize, message: 'Upload complete' });
    });

    fileStream.on('error', (err) => {
        console.error('File write error:', err);
        res.status(500).json({ error: 'Upload failed' });
    });
});

router.get('/files/:id/status', async (req, res) => {
    const [rows] = await pool.execute('SELECT id, filename, mime, size, uploaded_at FROM files WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
        return res.status(404).json({ error: 'File not found' });
    }
    res.json(rows[0]);
});

router.get('/files/:id', async (req, res) => {
    const [rows] = await pool.execute('SELECT id, filename, mime, size, uploaded_at FROM files WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
        return res.status(404).json({ error: 'File not found' });
    }
    res.json(rows[0]);
});

router.get('/files/:id/download', async (req, res) => {
    const [rows] = await pool.execute('SELECT filename, path FROM files WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
        return res.status(404).json({ error: 'File not found' });
    }
    const fileRecord = rows[0];
    res.download(fileRecord.path, fileRecord.filename);
});

router.delete('/files/:id', async (req, res) => {
    const [rows] = await pool.execute('SELECT path FROM files WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
        return res.status(404).json({ error: 'File not found' });
    }
    const filePath = rows[0].path;
    try { fs.unlinkSync(filePath); } catch (e) { }
    await pool.execute('DELETE FROM files WHERE id = ?', [req.params.id]);
    res.json({ message: 'File deleted' });
});

module.exports = router;
