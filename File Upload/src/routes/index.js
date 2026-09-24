const express = require('express');
const router = express.Router();
const largeFilerouter = require('./largeUpload');
const chunkFilerouter = require('./chunkedUploads');
const s3UploadRouter = require('./s3Uploads');
router.use('/stream',largeFilerouter);
router.use('/s3', s3UploadRouter);
router.use('/chunk',chunkFilerouter);

module.exports = router;