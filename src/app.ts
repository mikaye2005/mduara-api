import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import routes from './routes/index.routes';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { authenticate } from './middlewares/auth.middleware';
import { requireRoles } from './middlewares/authorization.middleware';

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buffer) => {
    const url = req.url ?? '';
    if (url.includes('/api/v1/payments/callback') || url.includes('/api/v1/payments/mpesa/callback')) {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    }
  },
}));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Platform administration is a global identity capability, never a Chama office.
// Keeping this guard ahead of the API router makes every current/future admin route fail closed.
app.use('/api/v1/admin', authenticate, requireRoles(['SUPER_ADMIN']));

app.use('/api/v1', routes);

app.use(notFoundHandler);
app.use(errorHandler);
