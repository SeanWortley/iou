import { config } from './config';
import express from 'express';
import cors from 'cors';
import { remitRouter } from './routes/remit';
import { callbackRouter } from './routes/callback';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { errorHandler } from './middleware/errorHandler';

const app = express();

app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'openremit-backend' });
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/remit', remitRouter);
app.use('/api/callback', callbackRouter);

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`\n  OpenRemit backend → http://localhost:${config.port}\n`);
});
