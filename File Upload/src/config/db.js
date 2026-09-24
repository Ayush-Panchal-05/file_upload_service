const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

// it is just for example like if i want to store anything like meta data or the file content.
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'file_upload',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});


const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

module.exports = { pool, uploadDir };
