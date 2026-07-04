'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Play, RotateCcw, Monitor, Cpu, Server, Terminal, CheckCircle2, AlertTriangle, HelpCircle, ShieldAlert, Layers } from 'lucide-react';
import { BenchmarkMetrics, formatMs, calculateNetworkOverhead } from '../lib/metrics';

interface LogEntry {
  id: string;
  timestamp: string;
  tag: 'WASM' | 'WebGPU' | 'Server' | 'System';
  type: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

interface BatchSlotMetrics {
  rtt: number;
  infer: number;
  overhead: number;
  init: number;
}

const PRESETS = {
  short: "Great performance, highly recommended!",
  medium: "I purchased this model benchmarking dashboard yesterday. The installation process was incredibly smooth, taking less than five minutes. The custom SVG charts look absolutely stunning and offer great responsiveness. However, I noticed a slight delay during the initial WebGPU buffer allocation on older browsers. Overall, it is a premium product that provides excellent value for money.",
  long: "The historical conflict between edge-localized computation and centralized cloud backends represents a fundamental architectural crossroads in software engineering. Historically, client-side browsers were treated as dumb terminals designed to render HTML and handle trivial scripting. Heavy lifting, such as machine learning inference, database processing, and data transformations, was strictly delegated to centralized mainframes or massive server farms. However, with the rapid maturation of WebAssembly (WASM) and the introduction of WebGPU, modern browsers have evolved into powerful edge-computing nodes. By deploying lightweight, quantized neural networks directly to the browser, we offload massive compute costs, decrease single-user marginal hosting costs to zero, and provide instantaneous, offline-ready operations. Yet, edge computing introduces new variables: extreme variability in client hardware, battery constraints, and the initial bandwidth penalty of downloading model weights. In contrast, cloud backends run on dedicated, highly predictable CPU and GPU instances but are bound by network latency, TLS handshakes, and cold-starts on serverless platforms. Finding the tipping point where network latency exceeds raw edge compute processing time is key to designing high-performance modern web apps."
};

export default function Dashboard() {
  const [inputText, setInputText] = useState(PRESETS.medium);
  const [activePreset, setActivePreset] = useState<'short' | 'medium' | 'long' | 'custom'>('medium');
  const [selectedEnv, setSelectedEnv] = useState<'client-wasm' | 'client-webgpu' | 'server-railway'>('client-webgpu');
  const [isRunning, setIsRunning] = useState(false);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  
  const [currentProgressText, setCurrentProgressText] = useState('');
  const [progressVal, setProgressVal] = useState<number | null>(null);
  const [progressMessage, setProgressMessage] = useState('');
  
  // Diagnostics
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [currentRunMetrics, setCurrentRunMetrics] = useState<BenchmarkMetrics[]>([]);
  
  // Automated Batch Storage: maps "environment_payload" to SlotMetrics
  const [batchMetrics, setBatchMetrics] = useState<Record<string, BatchSlotMetrics>>({});
  
  const workerRef = useRef<Worker | null>(null);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  // Initialize Worker
  useEffect(() => {
    workerRef.current = new Worker(
      new URL('../workers/inference.worker.js', import.meta.url),
      { type: 'module' }
    );

    addLog('System', 'info', 'Inference WebWorker loaded. Ready for pipeline allocations.');

    workerRef.current.onmessage = (event) => {
      const data = event.data;

      if (data.type === 'progress') {
        setProgressVal(data.progress);
        setProgressMessage(data.message);
      } else if (data.type === 'init_complete') {
        setProgressVal(null);
        setProgressMessage('');
        addLog(
          data.device === 'webgpu' ? 'WebGPU' : 'WASM',
          'success',
          `Engine ready! Initialization took ${formatMs(data.initTimeMs)} (${data.status}).`
        );
      } else if (data.type === 'error') {
        setProgressVal(null);
        setProgressMessage('');
        addLog(data.device === 'webgpu' ? 'WebGPU' : 'WASM', 'error', data.error);
      }
    };

    return () => {
      workerRef.current?.terminate();
      addLog('System', 'warn', 'Worker context terminated.');
    };
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = (tag: LogEntry['tag'], type: LogEntry['type'], message: string) => {
    const timestamp = new Date().toTimeString().split(' ')[0];
    setLogs((prev) => [
      ...prev,
      { id: Math.random().toString(), timestamp, tag, type, message }
    ]);
  };

  const selectPreset = (type: 'short' | 'medium' | 'long') => {
    setActivePreset(type);
    setInputText(PRESETS[type]);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setActivePreset('custom');
    setInputText(e.target.value);
  };

  // Helper: Client execution
  const runWorkerCycle = (device: 'wasm' | 'webgpu', text: string, isCold: boolean): Promise<{
    inferenceTimeMs: number;
    initTimeMs: number;
    output: { label: string; score: number };
  }> => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) {
        reject(new Error('Worker not active'));
        return;
      }

      let initTimeVal = 0;

      const tempHandler = (e: MessageEvent) => {
        const data = e.data;
        if (data.type === 'init_complete') {
          initTimeVal = data.initTimeMs;
          // Pipeline is initialized; it is now safe to trigger inference execution
          workerRef.current?.postMessage({ action: 'infer', text });
        } else if (data.type === 'result') {
          workerRef.current?.removeEventListener('message', tempHandler);
          resolve({
            inferenceTimeMs: data.inferenceTimeMs,
            initTimeMs: initTimeVal,
            output: data.output
          });
        } else if (data.type === 'error') {
          workerRef.current?.removeEventListener('message', tempHandler);
          reject(new Error(data.error));
        }
      };

      workerRef.current.addEventListener('message', tempHandler);

      if (isCold) {
        // Send init first; tempHandler will post the infer message upon init_complete
        workerRef.current.postMessage({ action: 'init', device });
      } else {
        // Warm start: trigger inference immediately
        workerRef.current.postMessage({ action: 'infer', text });
      }
    });
  };

  // Helper: Server execution
  const runServerCycle = async (text: string): Promise<{
    inferenceTimeMs: number;
    initTimeMs: number;
    output: { label: string; score: number };
    isCold: boolean;
    totalRtt: number;
    ttfb: number;
  }> => {
    const startTime = performance.now();
    const response = await fetch('/api/infer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    const headersReceivedTime = performance.now();
    const ttfb = headersReceivedTime - startTime;

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || 'Server error');
    }

    const data = await response.json();
    const totalRtt = performance.now() - startTime;

    return {
      inferenceTimeMs: data.telemetry.inferenceTimeMs,
      initTimeMs: data.telemetry.initTimeMs,
      output: data.output,
      isCold: data.telemetry.isCold,
      totalRtt,
      ttfb
    };
  };

  // Target run driver (standard targeted run)
  const executeTargetedRun = async () => {
    if (isRunning || isBatchRunning) return;
    setIsRunning(true);
    setCurrentRunMetrics([]);

    const envTag = selectedEnv === 'client-wasm' ? 'WASM' : selectedEnv === 'client-webgpu' ? 'WebGPU' : 'Server';
    addLog('System', 'info', `Executing targeted benchmark on: ${selectedEnv.toUpperCase()}...`);

    const cyclesData: BenchmarkMetrics[] = [];

    try {
      // Cold Cycle (Cycle 0)
      setCurrentProgressText('Cycle 0 (Cold Start)');
      addLog(envTag, 'warn', 'Triggering Cold Start initialization & compiling step...');
      
      let cycle0Rtt = 0;
      let cycle0Init = 0;
      let cycle0Infer = 0;
      let cycle0Ttfb = 0;
      let cycle0IsCold = true;
      let cycle0Sentiment = { label: '', score: 0 };

      if (selectedEnv === 'client-wasm' || selectedEnv === 'client-webgpu') {
        const dev = selectedEnv === 'client-wasm' ? 'wasm' : 'webgpu';
        const start = performance.now();
        const result = await runWorkerCycle(dev, inputText, true);
        cycle0Rtt = performance.now() - start;
        cycle0Init = result.initTimeMs;
        cycle0Infer = result.inferenceTimeMs;
        cycle0Sentiment = result.output;
      } else {
        const result = await runServerCycle(inputText);
        cycle0Rtt = result.totalRtt;
        cycle0Init = result.initTimeMs;
        cycle0Infer = result.inferenceTimeMs;
        cycle0Ttfb = result.ttfb;
        cycle0IsCold = result.isCold;
        cycle0Sentiment = result.output;
      }

      const cycle0Overhead = calculateNetworkOverhead(cycle0Rtt, cycle0Init, cycle0Infer, cycle0Ttfb);

      cyclesData.push({
        id: Math.random().toString(),
        timestamp: Date.now(),
        environment: selectedEnv,
        payloadSize: inputText.length,
        isCold: cycle0IsCold,
        ttfbMs: cycle0Ttfb,
        initTimeMs: cycle0Init,
        inferenceTimeMs: cycle0Infer,
        networkOverheadMs: cycle0Overhead,
        totalRttMs: cycle0Rtt,
        sentiment: cycle0Sentiment
      });
      setCurrentRunMetrics([...cyclesData]);

      addLog(
        envTag,
        'success',
        `Cycle 0 Complete. Latency: ${formatMs(cycle0Rtt)} (Inference: ${formatMs(cycle0Infer)}, Init: ${formatMs(cycle0Init)}, Transit: ${formatMs(cycle0Overhead)})`
      );

      // Warm Cycles 1 to 3 (reduce cycles to 3 to align with batch performance speeds)
      for (let i = 1; i <= 3; i++) {
        setCurrentProgressText(`Cycle ${i} (Warm)`);
        addLog(envTag, 'info', `Executing Cycle ${i}: Warm steady-state execution...`);

        let rtt = 0;
        let init = 0;
        let infer = 0;
        let ttfb = 0;
        let sentiment = { label: '', score: 0 };

        if (selectedEnv === 'client-wasm' || selectedEnv === 'client-webgpu') {
          const dev = selectedEnv === 'client-wasm' ? 'wasm' : 'webgpu';
          const start = performance.now();
          const result = await runWorkerCycle(dev, inputText, false);
          rtt = performance.now() - start;
          infer = result.inferenceTimeMs;
          sentiment = result.output;
        } else {
          const result = await runServerCycle(inputText);
          rtt = result.totalRtt;
          init = result.initTimeMs;
          infer = result.inferenceTimeMs;
          ttfb = result.ttfb;
          sentiment = result.output;
        }

        const overhead = calculateNetworkOverhead(rtt, init, infer, ttfb);

        cyclesData.push({
          id: Math.random().toString(),
          timestamp: Date.now(),
          environment: selectedEnv,
          payloadSize: inputText.length,
          isCold: false,
          ttfbMs: ttfb,
          initTimeMs: init,
          inferenceTimeMs: infer,
          networkOverheadMs: overhead,
          totalRttMs: rtt,
          sentiment
        });
        setCurrentRunMetrics([...cyclesData]);

        addLog(envTag, 'success', `Cycle ${i} Complete. Latency: ${formatMs(rtt)} (Inference: ${formatMs(infer)}, Transit: ${formatMs(overhead)})`);
        await new Promise((r) => setTimeout(r, 100));
      }

      // Sync this run to the batch metrics map for graph integration
      const warmRuns = cyclesData.filter(c => !c.isCold);
      const avgRtt = warmRuns.reduce((s, r) => s + r.totalRttMs, 0) / warmRuns.length;
      const avgInfer = warmRuns.reduce((s, r) => s + r.inferenceTimeMs, 0) / warmRuns.length;
      const avgOverhead = warmRuns.reduce((s, r) => s + r.networkOverheadMs, 0) / warmRuns.length;
      const coldInit = cyclesData[0].initTimeMs;

      // Determine preset payload label
      const payloadKey = activePreset;
      if (payloadKey !== 'custom') {
        setBatchMetrics(prev => ({
          ...prev,
          [`${selectedEnv}_${payloadKey}`]: { rtt: avgRtt, infer: avgInfer, overhead: avgOverhead, init: coldInit }
        }));
      }

      addLog('System', 'success', 'Targeted benchmark series complete.');

    } catch (error: any) {
      console.error(error);
      addLog('System', 'error', `Targeted run failed: ${error.message || error}`);
    } finally {
      setIsRunning(false);
      setCurrentProgressText('');
    }
  };

  // Automated Batch Suite Execution (Run all 9 slots in a single click)
  const runAutomatedBatchSuite = async () => {
    if (isRunning || isBatchRunning) return;
    setIsBatchRunning(true);
    setCurrentRunMetrics([]);
    addLog('System', 'warn', '🚀 Launching Full Automated Batch Benchmarking Suite (9 Configurations)...');

    const payloads = [
      { key: 'short' as const, label: 'Short Payload', text: PRESETS.short },
      { key: 'medium' as const, label: 'Medium Payload', text: PRESETS.medium },
      { key: 'long' as const, label: 'Long Payload', text: PRESETS.long }
    ];

    const targets = [
      { key: 'client-wasm' as const, label: 'Client WASM', tag: 'WASM' as const },
      { key: 'client-webgpu' as const, label: 'Client WebGPU', tag: 'WebGPU' as const },
      { key: 'server-railway' as const, label: 'Server API', tag: 'Server' as const }
    ];

    // Local copy of batch metrics to compile values during execution loop
    const newBatchMetrics = { ...batchMetrics };

    try {
      for (const payload of payloads) {
        for (const target of targets) {
          const runKey = `${target.key}_${payload.key}`;
          setCurrentProgressText(`Testing: ${target.label} - ${payload.label}`);
          addLog('System', 'info', `[Batch Suite] Active: Testing ${target.label} on ${payload.label}...`);

          const slotRuns: { rtt: number; infer: number; overhead: number }[] = [];
          let coldInitTime = 0;

          // 1. CYCLE 0: Cold start
          addLog(target.tag, 'warn', `[Cold Start] Initializing graph for ${payload.label}...`);
          if (target.key === 'client-wasm' || target.key === 'client-webgpu') {
            const dev = target.key === 'client-wasm' ? 'wasm' : 'webgpu';
            const start = performance.now();
            const result = await runWorkerCycle(dev, payload.text, true);
            const totalRtt = performance.now() - start;
            coldInitTime = result.initTimeMs;
            const overhead = calculateNetworkOverhead(totalRtt, coldInitTime, result.inferenceTimeMs);
            slotRuns.push({ rtt: totalRtt, infer: result.inferenceTimeMs, overhead });
          } else {
            const result = await runServerCycle(payload.text);
            coldInitTime = result.initTimeMs;
            slotRuns.push({ rtt: result.totalRtt, infer: result.inferenceTimeMs, overhead: result.totalRtt - result.inferenceTimeMs - result.initTimeMs });
          }

          // 2. CYCLES 1-3: Warm starts
          for (let i = 1; i <= 3; i++) {
            if (target.key === 'client-wasm' || target.key === 'client-webgpu') {
              const dev = target.key === 'client-wasm' ? 'wasm' : 'webgpu';
              const start = performance.now();
              const result = await runWorkerCycle(dev, payload.text, false);
              const totalRtt = performance.now() - start;
              const overhead = calculateNetworkOverhead(totalRtt, 0, result.inferenceTimeMs);
              slotRuns.push({ rtt: totalRtt, infer: result.inferenceTimeMs, overhead });
            } else {
              const result = await runServerCycle(payload.text);
              slotRuns.push({ rtt: result.totalRtt, infer: result.inferenceTimeMs, overhead: result.totalRtt - result.inferenceTimeMs });
            }
            await new Promise((r) => setTimeout(r, 50));
          }

          // Compile warm averages (index 1 to 3)
          const warmAverages = slotRuns.slice(1);
          const avgRtt = warmAverages.reduce((sum, run) => sum + run.rtt, 0) / warmAverages.length;
          const avgInfer = warmAverages.reduce((sum, run) => sum + run.infer, 0) / warmAverages.length;
          const avgOverhead = warmAverages.reduce((sum, run) => sum + run.overhead, 0) / warmAverages.length;

          // Save to slot
          newBatchMetrics[runKey] = {
            rtt: avgRtt,
            infer: avgInfer,
            overhead: avgOverhead,
            init: coldInitTime
          };

          // Update UI state dynamically so the chart builds bar by bar
          setBatchMetrics({ ...newBatchMetrics });
          addLog(
            target.tag,
            'success',
            `[Batch Slot Complete] Warm Speed: ${formatMs(avgRtt)} (Inference: ${formatMs(avgInfer)}, Overhead: ${formatMs(avgOverhead)})`
          );
        }
      }

      addLog('System', 'success', '🎉 Batch Benchmarking Suite Completed successfully!');
    } catch (error: any) {
      console.error(error);
      addLog('System', 'error', `Batch suite interrupted: ${error.message || error}`);
    } finally {
      setIsBatchRunning(false);
      setCurrentProgressText('');
    }
  };

  const clearMetrics = () => {
    setBatchMetrics({});
    setCurrentRunMetrics([]);
    setLogs([]);
    addLog('System', 'info', 'Metrics wiped. System reset.');
  };

  // Find max value in current metrics to scale chart
  const activeRttValues = Object.values(batchMetrics).map(m => m.rtt);
  const maxChartVal = activeRttValues.length > 0 ? Math.max(...activeRttValues) * 1.15 : 400;

  // Single metrics card displays:
  const currentWarmRuns = currentRunMetrics.filter(r => !r.isCold);
  const currentMedianRtt = currentWarmRuns.length > 0 
    ? [...currentWarmRuns].sort((a, b) => a.totalRttMs - b.totalRttMs)[Math.floor(currentWarmRuns.length / 2)].totalRttMs
    : 0;
  const currentAvgInfer = currentWarmRuns.reduce((s, r) => s + r.inferenceTimeMs, 0) / (currentWarmRuns.length || 1);
  const currentAvgOverhead = currentWarmRuns.reduce((s, r) => s + r.networkOverheadMs, 0) / (currentWarmRuns.length || 1);
  const currentColdRun = currentRunMetrics.find(r => r.isCold);

  const getLinePath = (env: 'client-wasm' | 'client-webgpu' | 'server-railway') => {
    const points: string[] = [];
    
    const shortVal = batchMetrics[`${env}_short`]?.rtt;
    const mediumVal = batchMetrics[`${env}_medium`]?.rtt;
    const longVal = batchMetrics[`${env}_long`]?.rtt;

    if (shortVal !== undefined) {
      const y = 200 - (shortVal / maxChartVal) * 160;
      points.push(`100,${y}`);
    }
    if (mediumVal !== undefined) {
      const y = 200 - (mediumVal / maxChartVal) * 160;
      points.push(`260,${y}`);
    }
    if (longVal !== undefined) {
      const y = 200 - (longVal / maxChartVal) * 160;
      points.push(`420,${y}`);
    }

    if (points.length === 0) return '';
    return `M ${points.join(' L ')}`;
  };

  const renderNodes = (env: 'client-wasm' | 'client-webgpu' | 'server-railway', color: string) => {
    const payloads = [
      { key: 'short', x: 100 },
      { key: 'medium', x: 260 },
      { key: 'long', x: 420 }
    ];

    return payloads.map((p, i) => {
      const data = batchMetrics[`${env}_${p.key}`];
      if (!data) return null;

      const y = 200 - (data.rtt / maxChartVal) * 160;
      return (
        <g key={i}>
          <circle 
            cx={p.x} 
            cy={y} 
            r="4.5" 
            fill={color} 
            stroke="var(--surface)" 
            strokeWidth="1.5"
          />
          <text 
            x={p.x} 
            y={y - 8} 
            fill="var(--ink)" 
            fontSize="8.5" 
            fontWeight="700" 
            textAnchor="middle"
          >
            {data.rtt.toFixed(0)} ms
          </text>
        </g>
      );
    });
  };

  const generateDynamicAnalysis = () => {
    // Check if we have data for the major endpoints
    const keys = [
      'client-wasm_short', 'client-wasm_medium', 'client-wasm_long',
      'client-webgpu_short', 'client-webgpu_medium', 'client-webgpu_long',
      'server-railway_short', 'server-railway_medium', 'server-railway_long'
    ];
    
    const missing = keys.filter(k => !batchMetrics[k]);
    if (missing.length > 0) {
      return (
        <span style={{ fontStyle: 'italic', color: 'var(--ink-faint)' }}>
          Run the Automated Suite to compile real-time latency crossover analysis and compute insights.
        </span>
      );
    }

    // We have all data! Let's extract values
    const wasmShort = batchMetrics['client-wasm_short'].rtt;
    const wasmLong = batchMetrics['client-wasm_long'].rtt;
    const serverShort = batchMetrics['server-railway_short'].rtt;
    const serverLong = batchMetrics['server-railway_long'].rtt;

    const getFastest = (size: 'short' | 'medium' | 'long') => {
      const candidates = [
        { name: 'WASM CPU', val: batchMetrics[`client-wasm_${size}`].rtt, color: 'var(--color-wasm)' },
        { name: 'WebGPU GPU', val: batchMetrics[`client-webgpu_${size}`].rtt, color: 'var(--color-webgpu)' },
        { name: 'Server API', val: batchMetrics[`server-railway_${size}`].rtt, color: 'var(--color-server)' }
      ];
      candidates.sort((a, b) => a.val - b.val);
      return candidates;
    };

    const shortRank = getFastest('short');
    const longRank = getFastest('long');

    const fastestShort = shortRank[0];
    const slowestShort = shortRank[2];

    const fastestLong = longRank[0];
    const slowestLong = longRank[2];

    // Determine Crossover
    let crossoverText = '';
    const wasmShortIsFasterThanServer = wasmShort < serverShort;
    const serverLongIsFasterThanWasm = serverLong < wasmLong;

    if (wasmShortIsFasterThanServer && serverLongIsFasterThanWasm) {
      crossoverText = `A clear crossover occurs: Client WASM is faster than Server by ${(serverShort - wasmShort).toFixed(0)}ms on Short payloads, but Server overtakes WASM by ${(wasmLong - serverLong).toFixed(0)}ms on Long payloads. This demonstrates the exact tipping point where local execution bottlenecks are eclipsed by cloud compute throughput.`;
    } else if (serverShort < wasmShort && serverLong < wasmLong) {
      crossoverText = `No crossover was observed: Server API remained the fastest target across all payload sizes. This happens when the local client device's CPU/GPU is significantly slower than the cloud server, or network overhead is negligible.`;
    } else if (wasmShort < serverShort && wasmLong < serverLong) {
      crossoverText = `No crossover was observed: Client-side execution remained faster than the Cloud across all payload sizes. This indicates a high network latency bottleneck that offsets any cloud compute advantage, even for large inputs.`;
    } else {
      crossoverText = `A crossover exists: The fastest target shifted from ${fastestShort.name} (${fastestShort.val.toFixed(0)}ms) for Short text to ${fastestLong.name} (${fastestLong.val.toFixed(0)}ms) for Long text under these network conditions.`;
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '6px' }}>
        <p style={{ margin: 0, lineHeight: 1.45 }}>
          On <strong>Short text</strong>, the fastest target is <strong style={{ color: fastestShort.color }}>{fastestShort.name}</strong> ({fastestShort.val.toFixed(0)}ms), which is <strong>{(slowestShort.val / fastestShort.val).toFixed(1)}x faster</strong> than the slowest target ({slowestShort.name} at {slowestShort.val.toFixed(0)}ms).
        </p>
        <p style={{ margin: 0, lineHeight: 1.45 }}>
          On <strong>Long text</strong>, the landscape shifts: the fastest target is <strong style={{ color: fastestLong.color }}>{fastestLong.name}</strong> ({fastestLong.val.toFixed(0)}ms), outperforming the slowest target ({slowestLong.name} at {slowestLong.val.toFixed(0)}ms) by <strong>{(slowestLong.val / fastestLong.val).toFixed(1)}x</strong>.
        </p>
        <p style={{ margin: 0, borderLeft: '2px solid var(--accent)', paddingLeft: '10px', color: 'var(--ink-muted)', fontStyle: 'italic', lineHeight: 1.45 }}>
          {crossoverText}
        </p>
      </div>
    );
  };

  return (
    <div className="flex-column" style={{ maxWidth: 'var(--content-max)', margin: '0 auto', padding: '0 var(--page-padding) 40px' }}>
      
      {/* BRANDING HEADER */}
      <div className="header-container">
        <div className="logo-container">
          <div style={{
            background: 'var(--accent)',
            width: '30px',
            height: '30px',
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <Cpu size={16} color="var(--paper)" />
          </div>
          <div>
            <h1 className="logo-text" style={{ fontSize: '1.25rem', margin: 0 }}>AETHER</h1>
            <p className="logo-sub">Inference Benchmarking</p>
          </div>
        </div>
        <div className="mono" style={{ fontSize: '0.8rem', color: 'var(--ink-faint)', fontWeight: 500 }}>
          Transformers.js v3 + WebGPU
        </div>
      </div>

      {/* AUTOMATED CONTROLS BANNER */}
      <div className="card card-body flex-row" style={{
        background: 'var(--inset)',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '24px',
        flexWrap: 'wrap',
        gap: '16px'
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '600px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Layers size={18} className="color-webgpu" />
            <h2 className="eyebrow" style={{ fontSize: '0.85rem', margin: 0, color: 'var(--ink)' }}>One-Click Automated Benchmarking Suite</h2>
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--ink-muted)', marginTop: '4px' }}>
            Execute all 9 testing matrices sequentially (Short, Medium, and Long text vs. Client WASM, Client WebGPU, and Server). This generates a complete grouped crossover visual to isolate the tipping point.
          </p>
        </div>
        <div className="flex-row" style={{ alignItems: 'center', gap: '16px' }}>
          <button 
            className="btn-primary"
            onClick={runAutomatedBatchSuite}
            disabled={isBatchRunning || isRunning}
            style={{ padding: '10px 20px', fontSize: '0.85rem' }}
          >
            {isBatchRunning ? (
              <>
                <span className="console-cursor" style={{ margin: 0, width: '8px', height: '12px' }} />
                <span>Running...</span>
              </>
            ) : (
              <span>Run Automated Suite</span>
            )}
          </button>
        </div>
      </div>

      {/* DASHBOARD GRID */}
      <div className="dashboard-grid">
        
        {/* LEFT COLUMN: Input & Settings */}
        <div className="flex-column">
          
          <div className="card card-body flex-column" style={{ gap: '16px' }}>
            <span className="eyebrow">1. Select Benchmark Payload</span>
            
            <div className="flex-row" style={{ flexWrap: 'wrap', gap: '8px' }}>
              <button 
                className={`preset-chip ${activePreset === 'short' ? 'active' : ''}`}
                onClick={() => selectPreset('short')}
                disabled={isBatchRunning || isRunning}
              >
                Short (~15 words)
              </button>
              <button 
                className={`preset-chip ${activePreset === 'medium' ? 'active' : ''}`}
                onClick={() => selectPreset('medium')}
                disabled={isBatchRunning || isRunning}
              >
                Medium (~150 words)
              </button>
              <button 
                className={`preset-chip ${activePreset === 'long' ? 'active' : ''}`}
                onClick={() => selectPreset('long')}
                disabled={isBatchRunning || isRunning}
              >
                Long (~600 words)
              </button>
            </div>

            <textarea
              className="text-area-input"
              value={inputText}
              onChange={handleTextChange}
              disabled={isBatchRunning || isRunning}
              placeholder="Write custom payload text..."
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--ink-faint)' }}>
              <span>Character Count: {inputText.length}</span>
              <span>Approx. Words: {inputText.split(/\s+/).filter(Boolean).length}</span>
            </div>
          </div>

          <div className="card card-body flex-column" style={{ gap: '16px' }}>
            <span className="eyebrow">2. Manual Target Override</span>
            
            <div className="flex-column" style={{ gap: '10px' }}>
              <label className="flex-row" style={{
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: '8px',
                background: selectedEnv === 'client-wasm' ? 'var(--inset)' : 'var(--surface)',
                border: `1px solid ${selectedEnv === 'client-wasm' ? 'var(--color-wasm)' : 'var(--line)'}`,
                cursor: 'pointer',
                transition: 'all var(--transition)'
              }}>
                <input type="radio" checked={selectedEnv === 'client-wasm'} onChange={() => setSelectedEnv('client-wasm')} disabled={isBatchRunning || isRunning} style={{ display: 'none' }} />
                <Monitor className="color-wasm" size={16} />
                <span style={{ fontSize: '0.85rem', fontWeight: 500, marginLeft: '10px', color: 'var(--ink)' }}>Client: WebAssembly (WASM CPU)</span>
              </label>

              <label className="flex-row" style={{
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: '8px',
                background: selectedEnv === 'client-webgpu' ? 'var(--inset)' : 'var(--surface)',
                border: `1px solid ${selectedEnv === 'client-webgpu' ? 'var(--color-webgpu)' : 'var(--line)'}`,
                cursor: 'pointer',
                transition: 'all var(--transition)'
              }}>
                <input type="radio" checked={selectedEnv === 'client-webgpu'} onChange={() => setSelectedEnv('client-webgpu')} disabled={isBatchRunning || isRunning} style={{ display: 'none' }} />
                <Cpu className="color-webgpu" size={16} />
                <span style={{ fontSize: '0.85rem', fontWeight: 500, marginLeft: '10px', color: 'var(--ink)' }}>Client: WebGPU (VRAM GPU)</span>
              </label>

              <label className="flex-row" style={{
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: '8px',
                background: selectedEnv === 'server-railway' ? 'var(--inset)' : 'var(--surface)',
                border: `1px solid ${selectedEnv === 'server-railway' ? 'var(--color-server)' : 'var(--line)'}`,
                cursor: 'pointer',
                transition: 'all var(--transition)'
              }}>
                <input type="radio" checked={selectedEnv === 'server-railway'} onChange={() => setSelectedEnv('server-railway')} disabled={isBatchRunning || isRunning} style={{ display: 'none' }} />
                <Server className="color-server" size={16} />
                <span style={{ fontSize: '0.85rem', fontWeight: 500, marginLeft: '10px', color: 'var(--ink)' }}>Server: Container API (Node.js)</span>
              </label>
            </div>

            <button 
              className="btn-secondary" 
              onClick={executeTargetedRun} 
              disabled={isRunning || isBatchRunning || (progressVal !== null && progressVal < 100)}
              style={{
                justifyContent: 'center',
                padding: '10px',
                fontSize: '0.85rem'
              }}
            >
              {isRunning ? (
                <span>Benchmarking...</span>
              ) : (
                <>
                  <Play size={14} fill="currentColor" />
                  <span>Run Targeted Slot</span>
                </>
              )}
            </button>
          </div>

        </div>

        {/* RIGHT COLUMN: Results & Console */}
        <div className="flex-column">
          
          <div className="card card-body flex-column" style={{ gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="eyebrow">Targeted Run Diagnostics</span>
              {currentRunMetrics.length > 0 && (
                <span className="tag" style={{
                  fontWeight: 600,
                  color: currentWarmRuns[0]?.sentiment.label === 'POSITIVE' ? 'var(--color-server)' : 'var(--color-error)',
                  background: 'var(--inset)'
                }}>
                  {currentWarmRuns[0]?.sentiment.label} ({(currentWarmRuns[0]?.sentiment.score * 100).toFixed(1)}%)
                </span>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
              <div className="metric-card">
                <span className="meta">RTT Latency</span>
                <span className="metric-value" style={{ 
                  color: selectedEnv === 'client-wasm' ? 'var(--color-wasm)' : selectedEnv === 'client-webgpu' ? 'var(--color-webgpu)' : 'var(--color-server)' 
                }}>
                  {isRunning ? '...' : currentRunMetrics.length > 0 ? formatMs(currentMedianRtt) : '—'}
                </span>
                <span className="meta" style={{ fontSize: '10px' }}>Warm Median</span>
              </div>

              <div className="metric-card">
                <span className="meta">Pure Inference</span>
                <span className="metric-value">
                  {isRunning ? '...' : currentRunMetrics.length > 0 ? formatMs(currentAvgInfer) : '—'}
                </span>
                <span className="meta" style={{ fontSize: '10px' }}>Warm Compute</span>
              </div>

              <div className="metric-card">
                <span className="meta">Transit Overhead</span>
                <span className="metric-value">
                  {isRunning ? '...' : currentRunMetrics.length > 0 ? formatMs(currentAvgOverhead) : '—'}
                </span>
                <span className="meta" style={{ fontSize: '10px' }}>Network/Worker Lag</span>
              </div>

              <div className="metric-card">
                <span className="meta">Cold Init</span>
                <span className="metric-value">
                  {isRunning ? '...' : currentColdRun ? formatMs(currentColdRun.initTimeMs) : '—'}
                </span>
                <span className="meta" style={{ fontSize: '10px' }}>Graph Compiler</span>
              </div>
            </div>

            {progressVal !== null && (
              <div style={{ 
                background: 'var(--inset)', 
                border: '1px solid var(--line-soft)',
                borderRadius: '8px',
                padding: '10px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                  <span style={{ color: 'var(--accent-ink)', fontWeight: 600 }}>{progressMessage}</span>
                  <span style={{ fontWeight: 600 }}>{progressVal.toFixed(0)}%</span>
                </div>
                <div style={{ width: '100%', height: '4px', background: 'var(--line-soft)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ width: `${progressVal}%`, height: '100%', background: 'var(--accent)' }} />
                </div>
              </div>
            )}
          </div>

          <div className="card card-body flex-column" style={{ gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Terminal size={14} style={{ color: 'var(--accent-ink)' }} />
                <span className="eyebrow" style={{ color: 'var(--ink)' }}>Execution Logs Console</span>
              </div>
              <button onClick={clearMetrics} style={{ background: 'transparent', border: 'none', color: 'var(--ink-faint)', cursor: 'pointer', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <RotateCcw size={10} />
                <span>Wipe Logs</span>
              </button>
            </div>

            <div className="console-panel" style={{ height: '180px' }}>
              {logs.length === 0 ? (
                <div style={{ color: 'var(--ink-faint)', fontStyle: 'italic' }}>
                  Ready to test. Click "Run Automated Suite" above to benchmark everything.
                  <span className="console-cursor" />
                </div>
              ) : (
                logs.map((log) => {
                  let tagColor = 'var(--ink-muted)';
                  if (log.tag === 'WASM') tagColor = 'var(--color-wasm)';
                  else if (log.tag === 'WebGPU') tagColor = 'var(--color-webgpu)';
                  else if (log.tag === 'Server') tagColor = 'var(--color-server)';

                  let msgColor = 'inherit';
                  if (log.type === 'error') msgColor = 'var(--color-error)';
                  else if (log.type === 'success') msgColor = 'var(--ink)';
                  else if (log.type === 'warn') msgColor = 'var(--color-warning)';

                  return (
                    <div key={log.id} className="console-line" style={{ color: msgColor }}>
                      <span className="console-timestamp">[{log.timestamp}]</span>
                      <span className="console-tag" style={{ color: tagColor }}>[{log.tag}]</span>
                      <span>{log.message}</span>
                    </div>
                  );
                })
              )}
              {(isBatchRunning || isRunning) && (
                <div className="console-line" style={{ color: 'var(--accent-ink)' }}>
                  <span className="console-timestamp">[{new Date().toTimeString().split(' ')[0]}]</span>
                  <span className="console-tag" style={{ color: 'var(--accent-ink)' }}>[System]</span>
                  <span>Executing active task: {currentProgressText}...</span>
                  <span className="console-cursor" />
                </div>
              )}
              <div ref={logsEndRef} />
            </div>
          </div>

        </div>

      </div>

      {/* COMPARATIVE VISUALIZATIONS (GROUPED CROSSOVER LINE CHART) */}
      <div className="card card-body flex-column" style={{ gap: '20px', marginTop: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className="eyebrow" style={{ color: 'var(--ink)', fontSize: '0.9rem', margin: 0 }}>Grouped Payload Crossover Analysis (Warm RTT)</h2>
          <span className="meta" style={{ color: 'var(--color-server)', fontWeight: 600 }}>
            Live Railway Cloud Network Latency
          </span>
        </div>
        
        {Object.keys(batchMetrics).length === 0 ? (
          <div style={{
            height: '240px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--inset)',
            border: '1px dashed var(--line)',
            borderRadius: '10px',
            color: 'var(--ink-faint)',
            fontSize: '0.9rem',
            gap: '12px'
          }}>
            <Layers size={24} style={{ color: 'var(--line)' }} />
            <span>No batch measurements recorded. Run the Automated Suite above to compile crossover metrics.</span>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '3fr 1.2fr', gap: '30px', alignItems: 'center' }}>
            
            {/* Custom SVG Grouped Line Chart */}
            <div style={{ width: '100%', overflow: 'visible' }}>
              <svg viewBox="0 0 540 260" style={{ width: '100%', height: 'auto', overflow: 'visible' }}>
                <defs>
                  {/* Subtle soft shadow filter for light theme */}
                  <filter id="soft-shadow" x="-10%" y="-10%" width="120%" height="120%">
                    <feDropShadow dx="0" dy="1.5" stdDeviation="2" floodOpacity="0.08" />
                  </filter>
                </defs>

                {/* Y-Axis Grid Lines */}
                {[0, 0.25, 0.5, 0.75, 1].map((ratio, i) => {
                  const y = 200 - ratio * 160;
                  const label = (maxChartVal * ratio).toFixed(0) + 'ms';
                  return (
                    <g key={i}>
                      <line x1="50" y1={y} x2="480" y2={y} stroke="var(--line-soft)" strokeWidth="1" strokeDasharray="3 3" />
                      <text x="40" y={y + 4} fill="var(--ink-faint)" fontSize="9" textAnchor="end">{label}</text>
                    </g>
                  );
                })}

                {/* Y-Axis line */}
                <line x1="50" y1="40" x2="50" y2="200" stroke="var(--line)" strokeWidth="1" />
                {/* X-Axis line */}
                <line x1="50" y1="200" x2="480" y2="200" stroke="var(--line)" strokeWidth="1" />

                {/* X-Axis Tick Labels */}
                {[
                  { label: 'Short (~15 words)', x: 100 },
                  { label: 'Medium (~150 words)', x: 260 },
                  { label: 'Long (~600 words)', x: 420 }
                ].map((tick, i) => (
                  <g key={i}>
                    <line x1={tick.x} y1="200" x2={tick.x} y2="205" stroke="var(--line)" strokeWidth="1" />
                    <text x={tick.x} y="220" fill="var(--ink)" fontSize="10" fontWeight="600" textAnchor="middle">
                      {tick.label}
                    </text>
                  </g>
                ))}

                {/* Render Crossover Lines */}
                {(() => {
                  const wasmPath = getLinePath('client-wasm');
                  const webgpuPath = getLinePath('client-webgpu');
                  const serverPath = getLinePath('server-railway');

                  return (
                    <g>
                      {/* WASM Line */}
                      {wasmPath && (
                        <path 
                          d={wasmPath} 
                          fill="none" 
                          stroke="var(--color-wasm)" 
                          strokeWidth="3" 
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          filter="url(#soft-shadow)"
                        />
                      )}
                      {/* WebGPU Line */}
                      {webgpuPath && (
                        <path 
                          d={webgpuPath} 
                          fill="none" 
                          stroke="var(--color-webgpu)" 
                          strokeWidth="3" 
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          filter="url(#soft-shadow)"
                        />
                      )}
                      {/* Server Line */}
                      {serverPath && (
                        <path 
                          d={serverPath} 
                          fill="none" 
                          stroke="var(--color-server)" 
                          strokeWidth="3" 
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          filter="url(#soft-shadow)"
                        />
                      )}

                      {/* Render Circle Nodes & Values */}
                      {renderNodes('client-wasm', 'var(--color-wasm)')}
                      {renderNodes('client-webgpu', 'var(--color-webgpu)')}
                      {renderNodes('server-railway', 'var(--color-server)')}
                    </g>
                  );
                })()}
              </svg>
            </div>

            {/* Legend & Breakdown explanations */}
            <div className="flex-column" style={{ gap: '14px', background: 'var(--inset)', padding: '16px', borderRadius: '10px', border: '1px solid var(--line-soft)' }}>
              <span className="eyebrow" style={{ color: 'var(--ink)' }}>Legend & Analysis</span>
              
              <div className="flex-column" style={{ gap: '8px', fontSize: '0.8rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '12px', height: '12px', borderRadius: '3px', background: 'var(--color-wasm)' }} />
                  <span style={{ color: 'var(--ink-muted)', fontWeight: 500 }}>Client WASM CPU</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '12px', height: '12px', borderRadius: '3px', background: 'var(--color-webgpu)' }} />
                  <span style={{ color: 'var(--ink-muted)', fontWeight: 500 }}>Client WebGPU GPU</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '12px', height: '12px', borderRadius: '3px', background: 'var(--color-server)' }} />
                  <span style={{ color: 'var(--ink-muted)', fontWeight: 500 }}>Server API</span>
                </div>
              </div>

              <div style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', borderTop: '1px solid var(--line)', paddingTop: '10px', lineHeight: 1.5 }}>
                <span style={{ display: 'block', fontWeight: 700, color: 'var(--ink)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '0.7rem' }}>Real-Time Latency Analysis</span>
                {generateDynamicAnalysis()}
              </div>
            </div>

          </div>
        )}
      </div>

    </div>
  );
}


