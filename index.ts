import 'dotenv/config';
import cors from 'cors';
import express, { Request, Response } from 'express';
import { handleScan } from './scanService';

const stripQuotes = (value?: string) => value?.replace(/^"(.*)"$/, '$1') ?? '';

const optionalEnv = (key: string, fallback = ''): string =>
  stripQuotes(process.env[key]) || fallback;

const app = express();

app.use(
  cors({
    origin: optionalEnv('CORS_ORIGIN') || true,
  }),
);
app.use(express.json({ limit: '15mb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.post('/api/scan', async (req: Request, res: Response) => {
  try {
    const { image } = req.body ?? {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ detail: 'Thiếu dữ liệu ảnh base64.' });
    }

    console.log('[scan] nhận ảnh, bắt đầu phân tích...');
    const result = await handleScan(image);
    res.json(result);
    console.log('[scan] hoàn tất, lưu tại', result.recordId);
  } catch (error) {
    console.error('Scan failed:', error);
    const message =
      error instanceof Error ? error.message : 'Không thể xử lý yêu cầu.';
    res.status(500).json({ detail: message });
  }
});

const port = Number(process.env.API_PORT) || 5050;

app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'scanner-api' });
});

app.listen(port, () => {
  console.log(`Scanner API đang chạy tại http://localhost:${port}`);
});

