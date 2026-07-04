import { env, pipeline } from '@huggingface/transformers';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define cache directory relative to project root (e.g. src/model-cache)
const cacheDir = path.resolve(__dirname, '..', 'model-cache');
env.cacheDir = cacheDir;

console.log(`[Build Step] Downloading model to cache: ${cacheDir}`);

async function download() {
  try {
    // Force download of the quantized DistilBERT sentiment classification model
    await pipeline('sentiment-analysis', 'Xenova/distilbert-base-uncased-finetuned-sst-2-english', {
      progress_callback: (progress) => {
        if (progress.status === 'downloading') {
          console.log(`Downloading ${progress.file}: ${(progress.loaded / progress.total * 100).toFixed(2)}%`);
        }
      }
    });
    console.log('[Build Step] Model downloaded and cached successfully.');
    process.exit(0);
  } catch (error) {
    console.error('[Build Step] Failed to download model:', error);
    process.exit(1);
  }
}

download();
