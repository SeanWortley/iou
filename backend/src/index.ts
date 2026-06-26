import { config } from './config';
import express from 'express';
import { callbackRouter } from './routes/callback';
import { errorHandler } from './middleware/errorHandler';

import botRouter from './routes/bot';

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'iou-bot' });
});

app.use('/api/callback', callbackRouter);

app.use('/bot', botRouter);

app.use(errorHandler);

app.listen(config.port, () => {
    console.log(`\n  IOU bot backend  →  http://localhost:${config.port}`);
    console.log(`  Telegram webhook →  ${config.telegram.webhookUrl}/telegram/webhook\n`);
});