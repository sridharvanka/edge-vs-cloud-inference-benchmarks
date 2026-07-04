export interface BenchmarkMetrics {
  id: string;
  timestamp: number;
  environment: 'client-wasm' | 'client-webgpu' | 'server-railway';
  payloadSize: number; // Input text character length
  isCold: boolean;     // Whether a cold start (download/compilation) occurred
  ttfbMs: number;      // Time to First Byte (network routing + server container boot)
  initTimeMs: number;  // Model weight loading and parsing time
  inferenceTimeMs: number; // Pure tensor calculation time
  networkOverheadMs: number; // Latency spent on network hop or worker serialization
  totalRttMs: number;  // Total user-experienced round-trip time
  sentiment: {
    label: string;
    score: number;
  };
}

export function formatMs(ms: number): string {
  if (ms < 1) return ms.toFixed(2) + ' ms';
  return ms.toFixed(1) + ' ms';
}

/**
 * Computes network overhead or postMessage serialization lag
 */
export function calculateNetworkOverhead(
  totalRtt: number,
  initTime: number,
  inferenceTime: number,
  ttfb: number = 0
): number {
  // Network overhead is the total RTT minus execution inside the execution context
  // For server: totalRtt - (server-side execution). But server execution time is initTime + inferenceTime.
  // So transit overhead is totalRtt - initTime - inferenceTime.
  // Note: we ensure it never goes below zero due to clock jitters.
  return Math.max(0, totalRtt - initTime - inferenceTime);
}
