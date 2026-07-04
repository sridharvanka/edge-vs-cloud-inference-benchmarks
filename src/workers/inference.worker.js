import { pipeline, env } from '@huggingface/transformers';

// Set up configuration for browser environments
env.allowLocalModels = false; // We download from HF Hub and let the browser's Cache API manage caching

let pipelineInstance = null;
let currentDevice = null;
const modelName = 'Xenova/distilbert-base-uncased-finetuned-sst-2-english';

self.onmessage = async (event) => {
  const { action, text, device } = event.data;

  if (action === 'init') {
    try {
      const startTime = performance.now();

      // If already initialized with the requested device, return immediately
      if (pipelineInstance && currentDevice === device) {
        self.postMessage({
          type: 'init_complete',
          status: 'already_initialized',
          initTimeMs: 0,
          device: currentDevice,
        });
        return;
      }

      self.postMessage({
        type: 'progress',
        status: 'initializing',
        progress: 0,
        message: `Initializing pipeline using ${device.toUpperCase()}...`
      });

      // Load model weights and create pipeline
      pipelineInstance = await pipeline('sentiment-analysis', modelName, {
        device: device === 'webgpu' ? 'webgpu' : 'wasm',
        progress_callback: (progress) => {
          if (progress.status === 'downloading') {
            const percent = (progress.loaded / progress.total) * 100;
            self.postMessage({
              type: 'progress',
              status: 'downloading',
              file: progress.file,
              progress: percent,
              message: `Downloading ${progress.file.split('/').pop()}: ${percent.toFixed(1)}%`
            });
          } else if (progress.status === 'done') {
            self.postMessage({
              type: 'progress',
              status: 'loaded_file',
              file: progress.file,
              progress: 100,
              message: `Loaded ${progress.file.split('/').pop()}`
            });
          } else if (progress.status === 'ready') {
            self.postMessage({
              type: 'progress',
              status: 'ready',
              progress: 100,
              message: 'Preparing model execution engine...'
            });
          }
        },
      });

      currentDevice = device;
      const initTimeMs = performance.now() - startTime;

      self.postMessage({
        type: 'init_complete',
        status: 'success',
        initTimeMs,
        device: currentDevice,
      });
    } catch (error) {
      console.error('[Web Worker] Error in init:', error);
      self.postMessage({
        type: 'error',
        device: device,
        error: `Could not load model with ${device.toUpperCase()}. ${
          device === 'webgpu' 
            ? 'Ensure your browser supports WebGPU and it is enabled in your flag settings, or try WASM.' 
            : error.message || error
        }`,
      });
    }
  }

  else if (action === 'infer') {
    if (!pipelineInstance) {
      self.postMessage({
        type: 'error',
        error: 'Pipeline not initialized. Send "init" first.',
      });
      return;
    }

    try {
      const startTime = performance.now();
      const output = await pipelineInstance(text);
      const inferenceTimeMs = performance.now() - startTime;

      self.postMessage({
        type: 'result',
        status: 'success',
        output: output[0], // Output has structure [{ label: 'POSITIVE', score: 0.999 }]
        inferenceTimeMs,
        device: currentDevice,
      });
    } catch (error) {
      console.error('[Web Worker] Error in inference:', error);
      self.postMessage({
        type: 'error',
        error: `Inference failed: ${error.message || error}`,
      });
    }
  }
};
