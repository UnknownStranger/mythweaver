import axios, { AxiosError, AxiosResponse } from 'axios';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { isLocalDevelopment } from '../lib/utils';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { prisma } from '../lib/providers/prisma';
import { ImageStylePreset } from '../controllers/images';
import { sendWebsocketMessage, WebSocketEvent } from './websockets';
import { rephraseImagePrompt } from './promptHelper';
import { parentLogger } from '../lib/logger';
const logger = parentLogger.getSubLogger();

const s3 = new S3Client({
  endpoint: 'https://sfo3.digitaloceanspaces.com',
  credentials: {
    accessKeyId: process.env.SPACES_KEY || '',
    secretAccessKey: process.env.SPACES_SECRET || '',
  },
  region: 'sfo3',
});

const engineId = 'stable-diffusion-v1-6';
const apiHost = process.env.API_HOST ?? 'https://api.stability.ai';
const apiKey = process.env.STABILITY_API_KEY;

interface GenerationResponse {
  artifacts: Array<{
    base64: string;
    seed: number;
    finishReason: 'SUCCESS' | 'CONTENT_FILTERED' | 'ERROR';
  }>;
  updatedPrompt?: string | undefined;
}

export interface ImageRequest {
  userId: number;
  prompt: string;
  count: number;
  negativePrompt?: string;
  stylePreset?: ImageStylePreset;
  linking?: {
    sessionId?: number;
    conjurationId?: number;
    characterId?: number;
  };
}

export const generateImage = async (request: ImageRequest) => {
  if (!apiKey) throw new Error('Missing Stability API key.');

  const preset = request.stylePreset || 'fantasy-art';

  const urls: string[] = [];
  let validImageCount = 0;
  let tries = 0;
  const maxImageTries = 30;

  do {
    tries += request.count;

    const imageResponse = await postToStableDiffusion(
      {
        ...request,
        count: request.count - validImageCount,
      },
      preset,
    );

    if (!imageResponse) {
      return undefined;
    }

    if (imageResponse.updatedPrompt) {
      await sendWebsocketMessage(
        request.userId,
        WebSocketEvent.ImagePromptRephrased,
        imageResponse.updatedPrompt,
      );
    }

    const artifacts = imageResponse.artifacts.filter(
      (a) => a.finishReason === 'SUCCESS',
    );

    for (const image of artifacts) {
      if (validImageCount === request.count) {
        break;
      }

      const imageId = uuidv4();
      let url = '';

      if (!isLocalDevelopment) {
        url = await uploadImage(imageId, image.base64);
      } else {
        url = saveImageLocally(imageId, image.base64);
      }

      urls.push(url);

      const createdImage = await prisma.image.create({
        data: {
          userId: request.userId,
          uri: url,
          prompt: request.prompt,
          negativePrompt: request.negativePrompt,
          stylePreset: preset,
          ...request.linking,
        },
      });

      await sendWebsocketMessage(
        request.userId,
        WebSocketEvent.ImageCreated,
        createdImage,
      );

      validImageCount++;
    }
  } while (validImageCount < request.count && tries < maxImageTries);

  if (validImageCount < request.count) {
    await sendWebsocketMessage(request.userId, WebSocketEvent.ImageFiltered, {
      message:
        'The image generation service was unable to generate an image that met the criteria. Please try again.',
    });
  } else {
    await sendWebsocketMessage(
      request.userId,
      WebSocketEvent.ImageGenerationDone,
      {},
    );
  }

  return urls;
};

const postToStableDiffusion = async (
  request: ImageRequest,
  preset: string,
  promptHistory: string[] = [],
  depth = 0,
): Promise<GenerationResponse | undefined> => {
  if (depth > 5) {
    return undefined;
  }

  let response: AxiosResponse<any, any>;

  try {
    response = await axios.post(
      `${apiHost}/v1/generation/${engineId}/text-to-image`,
      {
        text_prompts: [
          {
            text: request.prompt,
            weight: 1,
          },
          {
            text: `blurry, bad, ${request.negativePrompt}`,
            weight: -1,
          },
        ],
        cfg_scale: 7,
        height: 1024,
        width: 1024,
        steps: 30,
        samples: request.count,
        style_preset: preset,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );
  } catch (err) {
    await sendWebsocketMessage(request.userId, WebSocketEvent.ImageError, {
      message:
        'There was an error generating your image. Your prompt was rejected by the content filtering system. Please try again.',
    });

    return undefined;
  }

  return {
    artifacts: response.data.artifacts,
    updatedPrompt: depth === 0 ? undefined : request.prompt,
  };
};

export const saveImageLocally = (imageId: string, imageBase64: string) => {
  const dataDir = process.env.DATA_DIR ?? './public/images';

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(
    `${dataDir}/${imageId}.png`,
    Buffer.from(imageBase64, 'base64'),
  );

  return `${process.env.API_URL}/images/${imageId}.png`;
};

export const uploadImage = async (imageId: string, imageBase64: string) => {
  const buf = Buffer.from(imageBase64, 'base64');

  const command = new PutObjectCommand({
    Bucket: 'mythweaver-assets',
    Key: `${imageId}.png`,
    Body: buf,
    ContentEncoding: 'base64',
    ContentType: 'image/png',
    ACL: 'public-read',
  });

  await s3.send(command);

  return `https://assets.mythweaver.co/${command.input.Key}`;
};
