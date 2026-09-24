import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validation.middleware';
import {
  changePasswordSchema,
  loginSchema,
  refreshTokenSchema,
  registerSchema,
  resetPasswordSchema,
  sendOtpSchema,
  verifyOtpSchema,
} from '../validation/auth.validation';
import { asyncHandler } from '../utils/async-handler';

const router = Router();

router.post('/register', validateBody(registerSchema), asyncHandler(authController.register));
router.post('/login', validateBody(loginSchema), asyncHandler(authController.login));
router.post('/send-otp', validateBody(sendOtpSchema), asyncHandler(authController.sendOtp));
router.post('/verify-otp', validateBody(verifyOtpSchema), asyncHandler(authController.verifyOtp));
router.post('/reset-password', validateBody(resetPasswordSchema), asyncHandler(authController.resetPassword));
router.post('/refresh', validateBody(refreshTokenSchema), asyncHandler(authController.refresh));
router.post('/logout', validateBody(refreshTokenSchema), asyncHandler(authController.logout));
router.post('/logout-all', authenticate, asyncHandler(authController.logoutAll));

router.get('/me', authenticate, asyncHandler(authController.me));
router.patch('/password', authenticate, validateBody(changePasswordSchema), asyncHandler(authController.changePassword));

export default router;
