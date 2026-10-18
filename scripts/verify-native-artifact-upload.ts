import { requireNativeArtifactUpload } from './native-artifact-upload.js';

requireNativeArtifactUpload(
  process.env.NAKH_PRIMARY_UPLOAD_OUTCOME,
  process.env.NAKH_RETRY_UPLOAD_OUTCOME,
);
