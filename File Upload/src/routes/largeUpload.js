const express= require('express')
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { PassThrough } = require('stream');
const { v4: uuidv4 } = require('uuid');
const { pool, uploadDir } = require('../config/db');
const router = express.Router();
const maxUploadSize = 10 * 1024 * 1024 * 1024;
const uploadProgress = new Map();

function createProgress(uploadId, filename, bytesReceived, totalBytes, status) {
    return {
        id: uploadId,
        filename,
        bytesReceived,
        totalBytes,
        percentage: totalBytes ? Math.round((bytesReceived / totalBytes) * 100) : null,
        status
    };
}

router.post('/files/upload', (req, res) => {
    console.log("this is to check my body ", req) ;
    const fileId = req.get('x-upload-id') || uuidv4();
    let fileSize = 0;
    const originalName = req.get('x-filename') || `${fileId}.csv`;
    const safeName = path.basename(originalName);
    const contentLength = Number(req.get('content-length'));
    const totalBytes = Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null;
    const savePath = path.join(uploadDir, `${fileId}_${safeName}`);
    const fileStream = fs.createWriteStream(savePath);
    const pass = new PassThrough();
    uploadProgress.set(fileId, createProgress(fileId, safeName, 0, totalBytes, 'uploading'));

    req.on('data', (chunk) => {
        fileSize += chunk.length;
        uploadProgress.set(fileId, createProgress(fileId, safeName, fileSize, totalBytes, 'uploading'));
        if (fileSize > maxUploadSize) {
            req.unpipe();
            fileStream.destroy();
            fs.rmSync(savePath, { force: true });
            uploadProgress.set(fileId, createProgress(fileId, safeName, fileSize, totalBytes, 'failed'));
            return res.status(413).json({ error: 'File too large' });
        }
    });
    req.pipe(pass);
    pass.pipe(fileStream);
    pass.pipe(csv())
        .on('data', (row) => {
            console.log('CSV row:', row);
        })
        .on('end', async () => {
            try {
                // || <--------> below lines is to insert data into db.

                // const insertSQL = 'INSERT INTO files (id, filename, mime, size, path) VALUES (?, ?, ?, ?, ?)';
                // await pool.execute(insertSQL, [fileId, safeName, req.get('content-type') || 'application/octet-stream', fileSize, savePath]);

                //|| <----------->
                uploadProgress.delete(fileId);
                res.json({ id: fileId, filename: safeName, size: fileSize, message: 'Upload complete' });
            } catch (error) {
                uploadProgress.set(fileId, createProgress(fileId, safeName, fileSize, totalBytes, 'failed'));
                console.error('Upload metadata error:', error);
                res.status(500).json({ error: 'Upload failed' });
            }
        })
        .on('error', (err) => {
            console.error('CSV parsing error:', err);
            uploadProgress.set(fileId, createProgress(fileId, safeName, fileSize, totalBytes, 'failed'));
            res.status(500).json({ error: 'CSV parsing failed' });
        });
});

router.get('/files/:id/status', async (req, res) => {
    const activeUpload = uploadProgress.get(req.params.id);
    if (activeUpload) return res.json(activeUpload);

    const [rows] = await pool.execute('SELECT id, filename, mime, size, uploaded_at FROM files WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
        return res.status(404).json({ error: 'File not found' });
    }
    res.json({ ...rows[0], bytesReceived: rows[0].size, totalBytes: rows[0].size, percentage: 100, status: 'complete' });
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

// ye api delete ke liye check done.
router.delete('/files/:id', async (req, res) => {
    const [rows] = await pool.execute('SELECT path FROM files WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
        return res.status(404).json({ error: 'File not found' });
    }
    const filePath = rows[0].path;
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }

    // <----- delete query ----->
    // await pool.execute('DELETE FROM files WHERE id = ?', [req.params.id]);
    res.json({ message: 'File deleted' });
});

module.exports = router;