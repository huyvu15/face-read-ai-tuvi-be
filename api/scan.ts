import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleScan } from '../scanService';

const methodNotAllowed = (res: VercelResponse) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ detail: 'Method Not Allowed' });
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res);
  }

  const { image } = (req.body ?? {}) as { image?: unknown };
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ detail: 'Thiếu dữ liệu ảnh base64.' });
  }

  try {
    console.log('[scan] nhận ảnh, bắt đầu phân tích...');
    const result = await handleScan(image);
    res.status(200).json(result);
    console.log('[scan] hoàn tất, lưu tại', result.recordId);
  } catch (error) {
    console.error('Scan failed:', error);
    const message =
      error instanceof Error ? error.message : 'Không thể xử lý yêu cầu.';
    res.status(500).json({ detail: message });
  }
}


