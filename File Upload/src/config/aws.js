const { S3Client } = require('@aws-sdk/client-s3');
const { fromEnv } = require('@aws-sdk/credential-providers');

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: fromEnv()
});

module.exports = { s3 };
