import { NextRequest, NextResponse } from 'next/server';
import { pipeline, env } from '@huggingface/transformers';
import path from 'path';

// Define the absolute path to the local model cache baked into the container during the build phase
const cacheDir = path.resolve(process.cwd(), 'src', 'model-cache');
env.cacheDir = cacheDir;

// We allow loading models locally to ensure offline compliance and prevent runtime HTTP downloads
env.allowLocalModels = true; 

let classifierInstance: any = null;

async function getClassifier() {
  if (!classifierInstance) {
    classifierInstance = await pipeline('sentiment-analysis', 'Xenova/distilbert-base-uncased-finetuned-sst-2-english');
  }
  return classifierInstance;
}

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || (typeof text !== 'string' && !Array.isArray(text))) {
      return NextResponse.json({ error: 'Valid text input or string array is required' }, { status: 400 });
    }

    const initStart = performance.now();
    const isCold = classifierInstance === null;
    
    // Retrieve singleton instance (will compile on first execution)
    const classifier = await getClassifier();
    const initTimeMs = isCold ? performance.now() - initStart : 0;

    const inferenceStart = performance.now();
    const output = await classifier(text);
    const inferenceTimeMs = performance.now() - inferenceStart;

    return NextResponse.json({
      success: true,
      output: output[0], // Output has structure [{ label: 'POSITIVE', score: 0.999 }]
      telemetry: {
        initTimeMs,
        inferenceTimeMs,
        isCold,
        serverTimestamp: Date.now(),
      }
    });
  } catch (error: any) {
    console.error('[Server API Error]:', error);
    return NextResponse.json({ 
      success: false, 
      error: `Server-side inference failed. ${error.message || error}` 
    }, { status: 500 });
  }
}
