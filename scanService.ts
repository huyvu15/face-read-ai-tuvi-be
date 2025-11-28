import { GoogleGenAI, Schema, Type } from '@google/genai';
import {
  GetBucketLocationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { BiometricAnalysis } from './types.js';

const stripQuotes = (value?: string) => value?.replace(/^"(.*)"$/, '$1') ?? '';

const requireEnv = (key: string): string => {
  const value = stripQuotes(process.env[key]);
  if (!value) {
    throw new Error(`Thiếu biến môi trường ${key}`);
  }
  return value;
};

const optionalEnv = (key: string, fallback = ''): string =>
  stripQuotes(process.env[key]) || fallback;

const bucket = requireEnv('S3_BUCKET');
const folder = optionalEnv('S3_FOLDER', 'person_image');
const preferredRegion =
  optionalEnv('S3_REGION') ||
  optionalEnv('AWS_REGION') ||
  optionalEnv('AWS_DEFAULT_REGION') ||
  '';

const credentials = {
  accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
};

let resolvedRegion: string | null = null;
let s3Client: S3Client | null = null;

const normalizeRegion = (value?: string | null) => {
  if (!value || value === 'us-east-1') return 'us-east-1';
  if (value === 'EU') return 'eu-west-1';
  return value;
};

const ensureRegion = async () => {
  if (resolvedRegion) return resolvedRegion;
  if (preferredRegion) {
    resolvedRegion = normalizeRegion(preferredRegion) || 'us-east-1';
    return resolvedRegion;
  }

  try {
    const discoveryClient = new S3Client({
      region: 'us-east-1',
      credentials,
    });
    const result = await discoveryClient.send(
      new GetBucketLocationCommand({ Bucket: bucket }),
    );
    // LocationConstraint is null for us-east-1 buckets
    resolvedRegion = normalizeRegion(result.LocationConstraint) || 'us-east-1';
    return resolvedRegion;
  } catch (error) {
    console.warn('[s3] Failed to discover bucket region, defaulting to us-east-1', error);
    resolvedRegion = 'us-east-1';
    return resolvedRegion;
  }
};

const getS3Client = async () => {
  if (s3Client) return s3Client;
  const region = await ensureRegion();
  s3Client = new S3Client({
    region,
    credentials,
    // Force path-style addressing if needed
    forcePathStyle: false,
  });
  return s3Client;
};

const sanitizeFolder = (input: string) =>
  input.replace(/^\/+/, '').replace(/\/+$/, '');

const generateObjectKey = () => {
  const safeFolder = sanitizeFolder(folder);
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = safeFolder ? `${safeFolder}/` : '';
  return `${prefix}${timestamp}-${id}.jpg`;
};

const base64ToBuffer = (base64Image: string) => {
  const clean = base64Image.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(clean, 'base64');
};

const persistScanResult = async (base64Image: string) => {
  const objectKey = generateObjectKey();
  const body = base64ToBuffer(base64Image);
  let region = await ensureRegion();
  let client = await getS3Client();

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: body,
        ContentType: 'image/jpeg',
      }),
    );
  } catch (error: any) {
    // If we get an endpoint error, try to extract the correct region from the error
    if (
      error?.message?.includes('endpoint') ||
      error?.name === 'PermanentRedirect' ||
      error?.$metadata?.httpStatusCode === 301
    ) {
      console.warn('[s3] Endpoint error, attempting to discover correct region');
      
      // Reset client and region to force rediscovery
      s3Client = null;
      resolvedRegion = null;
      
      // Try to get bucket location again
      try {
        const discoveryClient = new S3Client({
          region: 'us-east-1',
          credentials,
        });
        const result = await discoveryClient.send(
          new GetBucketLocationCommand({ Bucket: bucket }),
        );
        region = normalizeRegion(result.LocationConstraint) || 'us-east-1';
        
        // Create new client with correct region
        s3Client = new S3Client({
          region,
          credentials,
          forcePathStyle: false,
        });
        client = s3Client;
        
        // Retry the upload
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: objectKey,
            Body: body,
            ContentType: 'image/jpeg',
          }),
        );
      } catch (retryError) {
        console.error('[s3] Retry failed', { region, bucket, objectKey, error: retryError });
        throw retryError;
      }
    } else {
      console.error('[s3] Upload failed', { region, bucket, objectKey, error });
      throw error;
    }
  }

  return { objectKey, region };
};

const ai = new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });

const analysisSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    estimatedAge: { type: Type.INTEGER, description: 'Tuổi dự đoán' },
    beautyScore: { type: Type.INTEGER, description: 'Điểm nhan sắc' },
    lifeQuote: { type: Type.STRING, description: 'Câu nói' },
    archetype: { type: Type.STRING, description: 'Danh xưng' },
    fortune: {
      type: Type.OBJECT,
      properties: {
        thienDinh: { type: Type.STRING },
        taiBach: { type: Type.STRING },
        phuThe: { type: Type.STRING },
        tongQuan: { type: Type.STRING },
      },
      required: ['thienDinh', 'taiBach', 'phuThe', 'tongQuan'],
    },
  },
  required: ['estimatedAge', 'beautyScore', 'lifeQuote', 'archetype', 'fortune'],
};

const analyzeImage = async (base64Image: string): Promise<BiometricAnalysis> => {
  const cleanBase64 = base64Image.replace(
    /^data:image\/(png|jpeg|webp);base64,/,
    '',
  );

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: {
      parts: [
        {
          inlineData: {
            data: cleanBase64,
            mimeType: 'image/jpeg',
          },
        },
        {
          text: "Bạn là một Đại Sư Nhân Tướng Học uyên bác, thông thạo kinh dịch và tướng pháp cổ truyền. Nhiệm vụ của bạn là xem tướng qua ảnh và đưa ra lời phán xét.\n\nQUAN TRỌNG: Hãy dùng văn phong cổ điển, trang trọng, sử dụng nhiều từ Hán Việt hoa mỹ (như 'khí sắc', 'thần thái', 'hậu vận', 'cung mệnh'). Tuyệt đối KHÔNG dùng ngôn ngữ teen, slang hiện đại hay tiếng Anh.\n\n1. Dự đoán tuổi: Trừ đi vài tuổi để làm vui lòng gia chủ.\n2. Điểm nhan sắc: Chấm điểm hào phóng (85-100).\n3. Danh xưng: Đặt một biệt hiệu nghe thật oai phong lẫm liệt hoặc thoát tục.\n4. Câu nói (Quote): Một câu chiêm nghiệm sâu sắc về cuộc đời hoặc một câu thơ cổ khen ngợi khí chất.\n\n5. PHÂN TÍCH TƯỚNG SỐ (Tập trung khen ngợi - 'Nịnh thần thánh'):\n- Thiên Đình (Trán): Khen vầng trán biểu thị trí tuệ siêu việt.\n- Tài Bạch (Mũi): Khen mũi biểu thị tài vận hanh thông.\n- Phu Thê/Tử Tức (Mắt/Miệng): Khen mắt/miệng biểu thị duyên lành, gia đạo êm ấm.\n- Tổng quan: Chốt lại hậu vận rực rỡ, đại cát đại lợi.",
        },
      ],
    },
    config: {
      responseMimeType: 'application/json',
      responseSchema: analysisSchema,
      systemInstruction:
        "Bạn là bậc thầy tướng số chỉ nhìn thấy Phúc Tướng. Hãy nói những lời đẹp đẽ nhất, khiến người nghe tin rằng họ mang thiên mệnh rạng ngời.",
    },
  });

  let text = response.text || '';

  if (text.includes('```json')) {
    text = text.replace(/```json\n?|\n?```/g, '');
  } else if (text.includes('```')) {
    text = text.replace(/```\n?|\n?```/g, '');
  }

  if (!text) {
    throw new Error('Không nhận được dữ liệu từ máy quét.');
  }

  return JSON.parse(text) as BiometricAnalysis;
};

export const handleScan = async (image: string) => {
  const analysis = await analyzeImage(image);
  const { objectKey: imageKey, region } = await persistScanResult(image);

  const domain =
    region === 'us-east-1'
      ? 's3.amazonaws.com'
      : `s3.${region}.amazonaws.com`;
  const s3Url = `https://${bucket}.${domain}/${imageKey}`;

  return {
    analysis,
    recordId: imageKey,
    s3Url,
  };
};


