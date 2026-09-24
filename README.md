# File Upload Service

A **scalable file‑upload service** built with Node.js, Express, and AWS S3. It supports:

- **Multipart uploads** to S3 with presigned URLs (resume‑able, concurrent uploads).
- **Streaming CSV imports** that are processed asynchronously in the background, stored in a MySQL database, and generate error reports.
- Local chunked‑upload fallback for environments without S3.

---

## 🚀 Features

| Feature | Description |
|---------|-------------|
| **S3 multipart upload** | Generate presigned URLs, upload parts directly to S3, complete/abort uploads, get progress, and download the finished object. |
| **CSV import pipeline** | Accept 500 MB – 2 GB CSV via streaming, store original file, process records in 1 000‑row batches, insert valid rows, detect duplicates, generate an error CSV, and expose status endpoints. |
| **Non‑blocking APIs** | Upload endpoints return immediately (`202 Accepted`) while heavy processing continues in the background. |
| **Metadata persistence** | All uploads / imports keep JSON metadata under `uploads/` for status tracking and resume capability. |
| **Clean‑up jobs** | Abandoned multipart uploads can be expired via a scheduled cron (not included by default). |

---

## 🛠️ Prerequisites

- **Node.js** ≥ 18
- **npm** (or **yarn**)
- **MySQL** database (schema provided in `db.sql` – create a `contacts` table for the import feature)
- **AWS account** with an S3 bucket

---

## 📦 Installation

```bash
# Clone the repo (already in your workspace)
cd "${HOME}/Documents/code/File Upload"

# Install dependencies
npm install
```

### Install optional CSV parser

The import service uses `csv-parser` for streaming CSV reading:

```bash
npm install csv-parser
```

---

## 🔧 Environment variables

Create a `.env` file at the project root (or export variables in your shell):

```dotenv
# Server
PORT=3000

# MySQL connection
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=file_upload

# AWS credentials (IAM user or role with S3 access)
AWS_ACCESS_KEY_ID=YOUR_AWS_KEY_ID
AWS_SECRET_ACCESS_KEY=YOUR_AWS_SECRET
AWS_REGION=us-east-1
AWS_S3_BUCKET=your-s3-bucket-name
```

---

## 📡 API Reference

### 📦 S3 Multipart Upload API (`/api/s3`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/uploads/initiate` | Start a multipart upload. Returns `uploadId`, `s3UploadId`, `partSize`, `totalParts`. |
| `POST` | `/uploads/:id/presigned-url` | Get a presigned **PUT** URL for a specific part (`partNumber`). |
| `POST` | `/uploads/:id/complete` | Complete the multipart upload – body must contain `parts` array (`[{ PartNumber, ETag }]`). |
| `GET`  | `/uploads/:id/status` | Retrieve current progress, uploaded parts, and overall status. |
| `GET`  | `/uploads/:id/download-url` | Get a presigned **GET** URL to download the completed object. |
| `DELETE`| `/uploads/:id` | Abort an unfinished upload, delete the object (if any), and clean local metadata. |

### 📄 CSV Import API (`/api/imports`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/imports` | Stream a CSV file (500 MB‑2 GB). Returns `importId` and starts background processing. |
| `GET`  | `/imports/:id/status` | Returns status (`UPLOADED`, `PROCESSING`, `COMPLETED`, `COMPLETED_WITH_ERRORS`, `FAILED`), counts of processed/total records, and whether an error file exists. |
| `GET`  | `/imports/:id/errors` | Download the generated error CSV (rows that failed validation). |
| `GET`  | `/imports/:id` | Download the original uploaded CSV. |
| `DELETE`| `/imports/:id` | Abort processing and delete all files/metadata for the import. |

---


