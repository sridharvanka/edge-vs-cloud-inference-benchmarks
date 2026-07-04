import Dashboard from '@/components/Dashboard';

export const metadata = {
  title: 'Aether - Edge vs Cloud ML Inference Benchmarking',
  description: 'A performance metrics platform benchmarking Transformers.js v3 client-side WebAssembly/WebGPU execution against persistent Node.js container backends.',
};

export default function Home() {
  return (
    <main style={{ minHeight: '100vh', paddingTop: '20px' }}>
      <Dashboard />
    </main>
  );
}
