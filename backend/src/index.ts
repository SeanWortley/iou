import { config } from './config';
import express from 'express';
import { callbackRouter } from './routes/callback';
import { errorHandler } from './middleware/errorHandler';

const app = express();

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'iou-bot' });
});

// Open Payments GNAP callback — the user's wallet redirects their browser here
// after they approve or deny the payment consent screen.
app.use('/api/callback', callbackRouter);

// Telegram webhook — every message, button tap, and group event arrives here.
// TODO: replace this stub with a grammy Bot instance once bot handlers are built.
app.post('/telegram/webhook', (req, res) => {
  console.log('[webhook]', JSON.stringify(req.body));
  res.sendStatus(200);
});

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`\n  IOU bot backend  →  http://localhost:${config.port}`);
  console.log(`  Telegram webhook →  ${config.telegram.webhookUrl}/telegram/webhook\n`);
});
