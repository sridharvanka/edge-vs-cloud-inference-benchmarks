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
  
  // Simulation Toggles
  const [simulateNetwork, setSimulateNetwork] = useState(true);
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
    const rawRtt = performance.now() - startTime;

    // Apply Network Latency Simulator offset if enabled
    const networkDelay = simulateNetwork ? 80 : 0;
    const totalRtt = rawRtt + networkDelay;
    const finalTtfb = ttfb + networkDelay;

    return {
      inferenceTimeMs: data.telemetry.inferenceTimeMs,
      initTimeMs: data.telemetry.initTimeMs,
      output: data.output,
      isCold: data.telemetry.isCold,
      totalRtt,
      ttfb: finalTtfb
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
            stroke="#0b0f19" 
            strokeWidth="1.5"
          />
          <text 
            x={p.x} 
            y={y - 8} 
            fill="#ffffff" 
            fontSize="8" 
            fontWeight="700" 
            textAnchor="middle"
          >
            {data.rtt.toFixed(0)} ms
          </text>
        </g>
      );
    });
  };

  return (
    <div className="flex-column" style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 20px 40px' }}>
      
      {/* BRANDING HEADER */}
      <div className="header-container">
        <div className="logo-container">
          <div style={{
            background: 'linear-gradient(135deg, hsl(270 95% 65%) 0%, hsl(190 95% 50%) 100%)',
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 15px rgba(139, 92, 246, 0.4)'
          }}>
            <Cpu size={18} color="#fff" />
          </div>
          <div>
            <h1 className="logo-text">AETHER</h1>
            <p className="logo-sub">Inference Benchmarking</p>
          </div>
        </div>
        <div className="flex-row" style={{ alignItems: 'center' }}>
          <span style={{ fontSize: '0.85rem', color: 'hsl(215 20% 50%)' }}>Transformers.js v3 + WebGPU</span>
        </div>
      </div>

      {/* AUTOMATED CONTROLS BANNER */}
      <div className="glass-panel" style={{
        background: 'linear-gradient(135deg, hsla(270, 95%, 65%, 0.08) 0%, hsla(190, 95%, 50%, 0.03) 100%)',
        border: '1px solid hsla(270, 95%, 65%, 0.25)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '20px 24px',
        flexWrap: 'wrap',
        gap: '16px'
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '600px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Layers size={18} className="glow-webgpu" />
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700 }}>One-Click Automated Benchmarking Suite</h2>
          </div>
          <p style={{ fontSize: '0.85rem', color: 'hsl(215 20% 65%)' }}>
            Execute all 9 testing matrices sequentially (Short, Medium, and Long text vs. Client WASM, Client WebGPU, and Server). This generates a complete grouped crossover visual to isolate the tipping point.
          </p>
        </div>
        <div className="flex-row" style={{ alignItems: 'center', gap: '16px' }}>
          {/* Deployed Network Simulator Toggle */}
          <label style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
            fontSize: '0.85rem',
            userSelect: 'none',
            background: 'rgba(0,0,0,0.2)',
            padding: '8px 12px',
            borderRadius: '8px',
            border: '1px solid hsl(217 32% 15%)'
          }}>
            <input 
              type="checkbox" 
              checked={simulateNetwork}
              onChange={(e) => setSimulateNetwork(e.target.checked)}
              disabled={isBatchRunning || isRunning}
              style={{ accentColor: 'hsl(150, 95%, 50%)' }}
            />
            <span style={{ color: simulateNetwork ? 'hsl(150, 95%, 50%)' : 'hsl(215 20% 50%)' }}>
              Simulate Deployed Network (+80ms RTT)
            </span>
          </label>

          <button 
            className="btn-primary"
            onClick={runAutomatedBatchSuite}
            disabled={isBatchRunning || isRunning}
            style={{ 
              animation: isBatchRunning ? 'none' : 'pulse-glow 3s infinite',
              background: 'linear-gradient(135deg, hsl(270, 95%, 60%) 0%, hsl(190, 95%, 50%) 100%)'
            }}
          >
            {isBatchRunning ? (
              <>
                <span className="console-cursor" style={{ margin: 0, width: '10px', height: '10px' }} />
                <span>Running Suite...</span>
              </>
            ) : (
              <span>Run Automated Suite</span>
            )}
          </button>
        </div>
      </div>

      {/* DASHBOARD GRID */}
      <div className="dashboard-grid">
        
        {/* LEFT COLUMN: Input & Settings (Manual Override) */}
        <div className="flex-column">
          
          <div className="glass-panel flex-column" style={{ gap: '16px' }}>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Manual Payload Override</h2>
            
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
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'hsl(215 20% 50%)' }}>
              <span>Character Count: {inputText.length}</span>
              <span>Approx. Words: {inputText.split(/\s+/).filter(Boolean).length}</span>
            </div>
          </div>

          <div className="glass-panel flex-column" style={{ gap: '16px' }}>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Manual Target Override</h2>
            
            <div className="flex-column" style={{ gap: '10px' }}>
              <label className="flex-row" style={{
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: '8px',
                background: selectedEnv === 'client-wasm' ? 'hsla(190, 95%, 50%, 0.05)' : 'rgba(8,12,21,0.2)',
                border: `1px solid ${selectedEnv === 'client-wasm' ? 'hsl(190, 95%, 50%)' : 'hsl(217 32% 15%)'}`,
                cursor: 'pointer'
              }}>
                <input type="radio" checked={selectedEnv === 'client-wasm'} onChange={() => setSelectedEnv('client-wasm')} disabled={isBatchRunning || isRunning} style={{ display: 'none' }} />
                <Monitor className="glow-wasm" size={16} />
                <span style={{ fontSize: '0.85rem', fontWeight: 500, marginLeft: '10px' }}>Client: WebAssembly (WASM CPU)</span>
              </label>

              <label className="flex-row" style={{
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: '8px',
                background: selectedEnv === 'client-webgpu' ? 'hsla(270, 95%, 65%, 0.05)' : 'rgba(8,12,21,0.2)',
                border: `1px solid ${selectedEnv === 'client-webgpu' ? 'hsl(270, 95%, 65%)' : 'hsl(217 32% 15%)'}`,
                cursor: 'pointer'
              }}>
                <input type="radio" checked={selectedEnv === 'client-webgpu'} onChange={() => setSelectedEnv('client-webgpu')} disabled={isBatchRunning || isRunning} style={{ display: 'none' }} />
                <Cpu className="glow-webgpu" size={16} />
                <span style={{ fontSize: '0.85rem', fontWeight: 500, marginLeft: '10px' }}>Client: WebGPU Acceleration (VRAM)</span>
              </label>

              <label className="flex-row" style={{
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: '8px',
                background: selectedEnv === 'server-railway' ? 'hsla(150, 95%, 50%, 0.05)' : 'rgba(8,12,21,0.2)',
                border: `1px solid ${selectedEnv === 'server-railway' ? 'hsl(150, 95%, 50%)' : 'hsl(217 32% 15%)'}`,
                cursor: 'pointer'
              }}>
                <input type="radio" checked={selectedEnv === 'server-railway'} onChange={() => setSelectedEnv('server-railway')} disabled={isBatchRunning || isRunning} style={{ display: 'none' }} />
                <Server className="glow-server" size={16} />
                <span style={{ fontSize: '0.85rem', fontWeight: 500, marginLeft: '10px' }}>Server: Container API (Node.js)</span>
              </label>
            </div>

            <button 
              className="btn-primary" 
              onClick={executeTargetedRun} 
              disabled={isRunning || isBatchRunning || (progressVal !== null && progressVal < 100)}
              style={{
                background: 'transparent',
                border: '1px solid hsl(217 32% 25%)',
                boxShadow: 'none',
                color: 'hsl(215 20% 80%)'
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
          
          <div className="glass-panel flex-column" style={{ gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Targeted Run Diagnostics</h2>
              {currentRunMetrics.length > 0 && (
                <span style={{
                  background: 'rgba(255,255,255,0.06)',
                  borderRadius: '4px',
                  padding: '3px 8px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: currentWarmRuns[0]?.sentiment.label === 'POSITIVE' ? 'hsl(150, 95%, 50%)' : 'hsl(350, 95%, 60%)'
                }}>
                  {currentWarmRuns[0]?.sentiment.label} ({(currentWarmRuns[0]?.sentiment.score * 100).toFixed(1)}%)
                </span>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
              <div className="metric-card">
                <span style={{ fontSize: '0.7rem', color: 'hsl(215 20% 50%)' }}>RTT Latency</span>
                <span className="metric-value" style={{ 
                  fontSize: '1.4rem',
                  color: selectedEnv === 'client-wasm' ? 'hsl(var(--accent-wasm))' : selectedEnv === 'client-webgpu' ? 'hsl(var(--accent-webgpu))' : 'hsl(var(--accent-server))' 
                }}>
                  {isRunning ? '...' : currentRunMetrics.length > 0 ? formatMs(currentMedianRtt) : '—'}
                </span>
                <span style={{ fontSize: '0.65rem', color: 'hsl(215 20% 40%)' }}>Warm Median</span>
              </div>

              <div className="metric-card">
                <span style={{ fontSize: '0.7rem', color: 'hsl(215 20% 50%)' }}>Pure Inference</span>
                <span className="metric-value" style={{ fontSize: '1.4rem' }}>
                  {isRunning ? '...' : currentRunMetrics.length > 0 ? formatMs(currentAvgInfer) : '—'}
                </span>
                <span style={{ fontSize: '0.65rem', color: 'hsl(215 20% 40%)' }}>Warm Compute</span>
              </div>

              <div className="metric-card">
                <span style={{ fontSize: '0.7rem', color: 'hsl(215 20% 50%)' }}>Transit Overhead</span>
                <span className="metric-value" style={{ fontSize: '1.4rem' }}>
                  {isRunning ? '...' : currentRunMetrics.length > 0 ? formatMs(currentAvgOverhead) : '—'}
                </span>
                <span style={{ fontSize: '0.65rem', color: 'hsl(215 20% 40%)' }}>Network/Worker Lag</span>
              </div>

              <div className="metric-card">
                <span style={{ fontSize: '0.7rem', color: 'hsl(215 20% 50%)' }}>Cold Init</span>
                <span className="metric-value" style={{ fontSize: '1.4rem' }}>
                  {isRunning ? '...' : currentColdRun ? formatMs(currentColdRun.initTimeMs) : '—'}
                </span>
                <span style={{ fontSize: '0.65rem', color: 'hsl(215 20% 40%)' }}>Graph Compilation</span>
              </div>
            </div>

            {progressVal !== null && (
              <div style={{ 
                background: 'rgba(8,12,21,0.6)', 
                border: '1px solid hsl(217 32% 15%)',
                borderRadius: '8px',
                padding: '10px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                  <span style={{ color: 'hsl(270 95% 65%)', fontWeight: 500 }}>{progressMessage}</span>
                  <span style={{ fontWeight: 600 }}>{progressVal.toFixed(0)}%</span>
                </div>
                <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ width: `${progressVal}%`, height: '100%', background: 'linear-gradient(90deg, hsl(270 95% 65%) 0%, hsl(190 95% 50%) 100%)' }} />
                </div>
              </div>
            )}
          </div>

          <div className="glass-panel flex-column" style={{ gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Terminal size={14} style={{ color: 'hsl(270 95% 65%)' }} />
                <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>Execution Logs Console</span>
              </div>
              <button onClick={clearMetrics} style={{ background: 'transparent', border: 'none', color: 'hsl(215 20% 50%)', cursor: 'pointer', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <RotateCcw size={10} />
                <span>Wipe Logs</span>
              </button>
            </div>

            <div className="console-panel" style={{ height: '180px' }}>
              {logs.length === 0 ? (
                <div style={{ color: 'hsl(215 20% 35%)', fontStyle: 'italic' }}>
                  Ready to test. Click "Run Automated Suite" above to benchmark everything.
                  <span className="console-cursor" />
                </div>
              ) : (
                logs.map((log) => {
                  let tagColor = 'hsl(215 20% 60%)';
                  if (log.tag === 'WASM') tagColor = 'hsl(var(--accent-wasm))';
                  else if (log.tag === 'WebGPU') tagColor = 'hsl(var(--accent-webgpu))';
                  else if (log.tag === 'Server') tagColor = 'hsl(var(--accent-server))';

                  let msgColor = 'inherit';
                  if (log.type === 'error') msgColor = 'hsl(var(--accent-error))';
                  else if (log.type === 'success') msgColor = '#ffffff';
                  else if (log.type === 'warn') msgColor = 'hsl(var(--accent-warning))';

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
                <div className="console-line" style={{ color: 'hsl(var(--accent-webgpu))' }}>
                  <span className="console-timestamp">[{new Date().toTimeString().split(' ')[0]}]</span>
                  <span className="console-tag" style={{ color: 'hsl(var(--accent-webgpu))' }}>[System]</span>
                  <span>Executing active task: {currentProgressText}...</span>
                  <span className="console-cursor" />
                </div>
              )}
              <div ref={logsEndRef} />
            </div>
          </div>

        </div>

      </div>

      {/* COMPARATIVE VISUALIZATIONS (GROUPED CROSSOVER BAR CHART) */}
      <div className="glass-panel flex-column" style={{ gap: '20px', marginTop: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 700 }}>Grouped Payload Crossover Analysis (Warm RTT)</h2>
          <span style={{ fontSize: '0.8rem', color: 'hsl(215 20% 50%)' }}>
            {simulateNetwork ? 'Simulated Network Active (+80ms Server Offset)' : 'Local Host Latency (Zero Server Network Offset)'}
          </span>
        </div>
        
        {Object.keys(batchMetrics).length === 0 ? (
          <div style={{
            height: '240px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(8,12,21,0.3)',
            border: '1px dashed hsl(217 32% 15%)',
            borderRadius: '12px',
            color: 'hsl(215 20% 40%)',
            fontSize: '0.9rem',
            gap: '12px'
          }}>
            <Layers size={24} style={{ color: 'hsl(215 20% 25%)' }} />
            <span>No batch measurements recorded. Run the Automated Suite or Targeted Slots to compile crossover metrics.</span>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '3fr 1.2fr', gap: '30px', alignItems: 'center' }}>
            
            {/* Custom SVG Grouped Bar Chart */}
            <div style={{ width: '100%', overflow: 'visible' }}>
              <svg viewBox="0 0 540 260" style={{ width: '100%', height: 'auto', overflow: 'visible' }}>
                <defs>
                  <filter id="glow-wasm" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feComposite in="SourceGraphic" in2="blur" operator="over" />
                  </filter>
                  <filter id="glow-webgpu" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feComposite in="SourceGraphic" in2="blur" operator="over" />
                  </filter>
                  <filter id="glow-server" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feComposite in="SourceGraphic" in2="blur" operator="over" />
                  </filter>
                </defs>

                {/* Y-Axis Grid Lines */}
                {[0, 0.25, 0.5, 0.75, 1].map((ratio, i) => {
                  const y = 200 - ratio * 160;
                  const label = (maxChartVal * ratio).toFixed(0) + 'ms';
                  return (
                    <g key={i}>
                      <line x1="50" y1={y} x2="480" y2={y} stroke="hsl(217 32% 12%)" strokeWidth="1" strokeDasharray="3 3" />
                      <text x="40" y={y + 4} fill="hsl(215 20% 40%)" fontSize="9" textAnchor="end">{label}</text>
                    </g>
                  );
                })}

                {/* Y-Axis line */}
                <line x1="50" y1="40" x2="50" y2="200" stroke="hsl(217 32% 20%)" strokeWidth="1" />
                {/* X-Axis line */}
                <line x1="50" y1="200" x2="480" y2="200" stroke="hsl(217 32% 20%)" strokeWidth="1" />

                {/* X-Axis Tick Labels */}
                {[
                  { label: 'Short (~15 words)', x: 100 },
                  { label: 'Medium (~150 words)', x: 260 },
                  { label: 'Long (~600 words)', x: 420 }
                ].map((tick, i) => (
                  <g key={i}>
                    <line x1={tick.x} y1="200" x2={tick.x} y2="205" stroke="hsl(217 32% 20%)" strokeWidth="1" />
                    <text x={tick.x} y="220" fill="hsl(215 20% 80%)" fontSize="10" fontWeight="600" textAnchor="middle">
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
                          stroke="hsl(var(--accent-wasm))" 
                          strokeWidth="3.5" 
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          filter="url(#glow-wasm)"
                          style={{ opacity: 0.9 }}
                        />
                      )}
                      {/* WebGPU Line */}
                      {webgpuPath && (
                        <path 
                          d={webgpuPath} 
                          fill="none" 
                          stroke="hsl(var(--accent-webgpu))" 
                          strokeWidth="3.5" 
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          filter="url(#glow-webgpu)"
                          style={{ opacity: 0.9 }}
                        />
                      )}
                      {/* Server Line */}
                      {serverPath && (
                        <path 
                          d={serverPath} 
                          fill="none" 
                          stroke="hsl(var(--accent-server))" 
                          strokeWidth="3.5" 
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          filter="url(#glow-server)"
                          style={{ opacity: 0.9 }}
                        />
                      )}

                      {/* Render Circle Nodes & Values */}
                      {renderNodes('client-wasm', 'hsl(var(--accent-wasm))')}
                      {renderNodes('client-webgpu', 'hsl(var(--accent-webgpu))')}
                      {renderNodes('server-railway', 'hsl(var(--accent-server))')}
                    </g>
                  );
                })()}
              </svg>
            </div>

            {/* Legend & Breakdown explanations */}
            <div className="flex-column" style={{ gap: '14px', background: 'rgba(8,12,21,0.4)', padding: '16px', borderRadius: '10px', border: '1px solid hsl(217 32% 15%)' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#ffffff' }}>Legend & Analysis</span>
              
              <div className="flex-column" style={{ gap: '8px', fontSize: '0.8rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '12px', height: '12px', borderRadius: '3px', background: 'hsl(var(--accent-wasm))' }} />
                  <span>Client WASM CPU</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '12px', height: '12px', borderRadius: '3px', background: 'hsl(var(--accent-webgpu))' }} />
                  <span>Client WebGPU GPU</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '12px', height: '12px', borderRadius: '3px', background: 'hsl(var(--accent-server))' }} />
                  <span>Server API</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '12px', height: '12px', borderRadius: '3px', background: 'hsl(350 95% 60%)' }} />
                  <span>Transit Overhead (Net/Worker)</span>
                </div>
              </div>

              <div style={{ fontSize: '0.75rem', color: 'hsl(215 20% 50%)', borderTop: '1px solid hsl(217 32% 15%)', paddingTop: '10px', lineHeight: 1.5 }}>
                <strong>How to read:</strong> Notice how WASM starts as the fastest target on <em>Short text</em> but grows significantly on <em>Long text</em>.
                <br /><br />
                Conversely, Server starts slowest on <em>Short text</em> due to network overhead, but becomes the fastest warm compute option on <em>Long text</em> once network transit is eclipsed by CPU execution gains.
              </div>
            </div>

          </div>
        )}
      </div>

    </div>
  );
}


