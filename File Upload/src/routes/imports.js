
const express = require('express');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream');
const csv = require('csv-parser');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/db');

const router = express.Router();


const importsRoot = path.join(__dirname, '../../uploads/imports');
if (!fs.existsSync(importsRoot)) {
  fs.mkdirSync(importsRoot, { recursive: true });
}

function metaPath(importId) {
  return path.join(importsRoot, importId, 'metadata.json');
}

async function writeMeta(importId, meta) {
  const dir = path.dirname(metaPath(importId));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(metaPath(importId), JSON.stringify(meta, null, 2));
}

async function readMeta(importId) {
  try {
    const data = await fs.promises.readFile(metaPath(importId), 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function processImport(importId) {
  const meta = await readMeta(importId);
  if (!meta) return;

  meta.status = 'PROCESSING';
  meta.processedRecords = 0;
  meta.totalRecords = 0;
  await writeMeta(importId, meta);

  const filePath = meta.filePath;
  const errors = [];
  const batch = [];
  const BATCH_SIZE = 1000;
  const seenPhones = new Set(); 

  const insertBatch = async (rows) => {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => '(?, ?, ?)').join(',');
    const values = [];
    for (const r of rows) {
      values.push(r.phone, r.name, r.email);
    }
    const sql = `INSERT INTO contacts (phone, name, email) VALUES ${placeholders}`;
    await pool.execute(sql, values);
  };

  const stream = fs.createReadStream(filePath).pipe(csv());

  for await (const row of stream) {
    meta.totalRecords++;
    const phone = (row.phone || '').trim();
    if (!phone) {
      errors.push({ ...row, error: 'Missing phone' });
      continue;
    }
    if (seenPhones.has(phone)) {
      errors.push({ ...row, error: 'Duplicate phone in file' });
      continue;
    }
    const [rows] = await pool.execute('SELECT 1 FROM contacts WHERE phone = ?', [phone]);
    if (rows.length > 0) {
      errors.push({ ...row, error: 'Duplicate phone in DB' });
      continue;
    }
    seenPhones.add(phone);
    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      await insertBatch(batch);
      meta.processedRecords += batch.length;
      batch.length = 0;
      await writeMeta(importId, meta);
    }
  }

  await insertBatch(batch);
  meta.processedRecords += batch.length;

  if (errors.length > 0) {
    const errorCsvPath = path.join(importsRoot, importId, 'errors.csv');
    const header = Object.keys(errors[0]);
    const write = fs.createWriteStream(errorCsvPath);
    write.write(header.join(',') + '\n');
    for (const e of errors) {
      write.write(header.map(h => `"${(e[h] ?? '').toString().replace(/"/g, '""')}"`).join(',') + '\n');
    }
    write.end();
    meta.errorCsv = errorCsvPath;
  }

  meta.status = errors.length ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
  await writeMeta(importId, meta);
}

router.post('/imports', (req, res) => {
  const importId = uuidv4();
  const importDir = path.join(importsRoot, importId);
  fs.mkdirSync(importDir, { recursive: true });
  const filePath = path.join(importDir, 'original.csv');
  const writeStream = fs.createWriteStream(filePath);

  pipeline(req, writeStream, async (err) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Upload failed' });
    }
    const meta = {
      importId,
      filePath,
      status: 'UPLOADED',
      createdAt: new Date().toISOString(),
      processedRecords: 0,
      totalRecords: 0,
      errorCsv: null
    };
    await writeMeta(importId, meta);
    setImmediate(() => processImport(importId).catch(console.error));
    res.status(202).json({ importId, message: 'File received, processing started' });
  });
});

router.get('/imports/:id/status', async (req, res) => {
  const meta = await readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Import not found' });
  const { importId, status, processedRecords, totalRecords, createdAt, errorCsv } = meta;
  res.json({ importId, status, processedRecords, totalRecords, createdAt, hasErrors: !!errorCsv });
});

router.get('/imports/:id/errors', async (req, res) => {
  const meta = await readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Import not found' });
  if (!meta.errorCsv) return res.status(404).json({ error: 'No error file' });
  res.setHeader('Content-Type', 'text/csv');
  fs.createReadStream(meta.errorCsv).pipe(res);
});

router.get('/imports/:id', async (req, res) => {
  const meta = await readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Import not found' });
  res.setHeader('Content-Type', 'text/csv');
  fs.createReadStream(meta.filePath).pipe(res);
});

router.delete('/imports/:id', async (req, res) => {
  const importId = req.params.id;
  const importPath = path.join(importsRoot, importId);
  if (!fs.existsSync(importPath)) return res.status(404).json({ error: 'Import not found' });
  await fs.promises.rm(importPath, { recursive: true, force: true });
  res.json({ message: 'Import data removed' });
});

module.exports = router;
