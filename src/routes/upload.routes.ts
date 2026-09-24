import { Router } from 'express';
import { authenticate, optionalAuthenticate } from '../middlewares/auth.middleware';
import uploadController from '../controllers/upload.controller';

const router = Router();

// Scanner endpoints must precede /:id so "scanner" is never parsed as an upload UUID.
router.post('/scanner/claim', uploadController.claimScans);
router.post('/:id/scan-result', uploadController.scanResult);

router.post('/', authenticate, uploadController.createUpload);
router.post('/:id/complete', authenticate, uploadController.completeUpload);
router.get('/:id', authenticate, uploadController.getUpload);
router.get('/:id/download', authenticate, uploadController.getDownload);
router.get('/:id/content', optionalAuthenticate, uploadController.contentRedirect);

export default router;
