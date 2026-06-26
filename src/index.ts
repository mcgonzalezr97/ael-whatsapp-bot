import 'dotenv/config';
import express from 'express';
import { handleWebhook, verifyWebhook } from './bot';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio envía form-encoded

app.get('/webhook', verifyWebhook);
app.post('/webhook', handleWebhook);
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => {
  console.log(`[AeL Bot] Servidor corriendo en http://localhost:${PORT}`);
  console.log(`[AeL Bot] Webhook endpoint: POST http://localhost:${PORT}/webhook`);
});
